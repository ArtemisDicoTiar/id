import Model from './model'
import Transaction from './transaction'
import { NoSuchEntryError, AuthenticationError, NotActivatedError, ExpiredTokenError } from './errors'
import * as argon2 from 'argon2'
import * as phc from '@phc/format'
import * as moment from 'moment'
import * as crypto from 'crypto'
import * as ldap from 'ldapjs'
import { PosixAccount, posixAccountObjectClass } from '../ldap/types'

// see language enum in schema.sql
export type Language = 'ko' | 'en'

export interface User {
  idx: number
  username: string | null
  name: string
  uid: number
  shell: string
  preferredLanguage: Language
}

export interface UserMembership {
  userIdx: number
  groupIdx: number
}

export default class Users {
  private readonly usersDN: string
  private posixAccountsCache: Array<ldap.SearchEntry<PosixAccount>> | null
  constructor(private readonly model: Model) {
    this.usersDN = `ou=${this.model.config.ldap.usersOU},${this.model.config.ldap.baseDN}`
    this.posixAccountsCache = null
  }

  public async create(tr: Transaction, username: string, password: string,
      name: string, shell: string, preferredLanguage: Language): Promise<number> {
    const query = 'INSERT INTO users(username, password_digest, name, uid, shell, preferred_language) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) RETURNING idx'
    const passwordDigest = await argon2.hash(password)
    const uid = await this.generateUid(tr)
    const result = await tr.query(query, [username, passwordDigest, name, uid, shell, preferredLanguage])
    this.posixAccountsCache = null
    return result.rows[0].idx
  }

  public async delete(tr: Transaction, userIdx: number): Promise<number> {
    const query = 'DELETE FROM users WHERE idx = $1 RETURNING idx'
    const result = await tr.query(query, [userIdx])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    this.posixAccountsCache = null
    return result.rows[0].idx
  }

  public async getAll(tr: Transaction): Promise<Array<User>> {
    const query = 'SELECT idx, username, name, uid, shell FROM users'
    const result = await tr.query(query)
    const users: Array<User> = []
    result.rows.forEach(row => users.push(this.rowToUser(row)))
    return users
  }

  public async getAllAsPosixAccounts(tr: Transaction): Promise<Array<ldap.SearchEntry<PosixAccount>>> {
    if (this.posixAccountsCache === null) {
      this.posixAccountsCache = this.usersToPosixAccounts(await this.getAll(tr))
    }
    return this.posixAccountsCache
  }

  public async getByUsername(tr: Transaction, username: string): Promise<User> {
    const query = 'SELECT idx, username, name, uid, shell FROM users WHERE username = $1'
    const result = await tr.query(query, [username])
    if (result.rows.length !== 1) {
      throw new NoSuchEntryError()
    }
    return this.rowToUser(result.rows[0])
  }

  public async getByUsernameAsPosixAccount(tr: Transaction, username: string):
      Promise<ldap.SearchEntry<PosixAccount>> {
    return this.userToPosixAccount(await this.getByUsername(tr, username))
  }

  public async getByUserIdx(tr: Transaction, userIdx: number): Promise<User> {
    const query = 'SELECT idx, username, name, uid, shell FROM users WHERE idx = $1'
    const result = await tr.query(query, [userIdx])
    if (result.rows.length !== 1) {
      throw new NoSuchEntryError()
    }
    return this.rowToUser(result.rows[0])
  }

  public async getUserIdxByEmailAddress(tr: Transaction, emailLocal: string, emailDomain: string): Promise<number> {
    const query = 'SELECT owner_idx FROM email_addresses WHERE LOWER(address_local) = LOWER($1) AND address_domain = $2'
    const result = await tr.query(query, [emailLocal, emailDomain])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].owner_idx
  }

  public async authenticate(tr: Transaction, username: string, password: string): Promise<number> {
    const query = 'SELECT idx, password_digest, activated FROM users WHERE username = $1'
    const result = await tr.query(query, [username])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }

    if (!result.rows[0].activated) {
      throw new NotActivatedError()
    }

    const idx: number = result.rows[0].idx

    const passwordDigest: string = result.rows[0].password_digest
    const phcObject = phc.deserialize(passwordDigest)
    if (['mssql-sha1', 'mssql-sha512'].includes(phcObject.id)) {
      const nullAppendedPassword = Buffer.from([...password].map(x => x + '\u0000').join(''))
      const hash = crypto.createHash(phcObject.id === 'mssql-sha1' ? 'sha1' : 'sha512')
      hash.update(nullAppendedPassword)
      hash.update(phcObject.salt)
      if (!hash.digest().equals(phcObject.hash)) {
        throw new AuthenticationError()
      }
      await this.changePassword(tr, idx, password)
    } else if (!await argon2.verify(passwordDigest, password)) {
      throw new AuthenticationError()
    }

    await this.model.users.updateLastLoginAt(tr, idx)
    return idx
  }

  public async updateLastLoginAt(tr: Transaction, userIdx: number): Promise<void> {
    const query = 'UPDATE users SET last_login_at = NOW() WHERE idx = $1'
    const result = await tr.query(query, [userIdx])
  }

  public async activate(tr: Transaction, userIdx: number): Promise<void> {
    const query = 'UPDATE users SET activated = TRUE WHERE idx = $1'
    const result = await tr.query(query, [userIdx])
  }

  public async deactivate(tr: Transaction, userIdx: number): Promise<void> {
    const query = 'UPDATE users SET activated = FALSE WHERE idx = $1'
    const result = await tr.query(query, [userIdx])
  }

  public async generateUid(tr: Transaction): Promise<number> {
    tr.ensureHasAccessExclusiveLock('users')
    const minUid = this.model.config.posix.minUid
    const getNewUidResult = await tr.query('SELECT b.uid + 1 AS uid FROM users AS a RIGHT OUTER JOIN ' +
      'users AS b ON a.uid = b.uid + 1 WHERE a.uid IS NULL AND b.uid + 1 >= $1 ORDER BY b.uid LIMIT 1', [minUid])
    return getNewUidResult.rows.length ? getNewUidResult.rows[0].uid : minUid
  }

  public async generatePasswordChangeToken(tr: Transaction, userIdx: number): Promise<string> {
    await this.resetResendCountIfExpired(tr, userIdx)
    const query = 'INSERT INTO password_change_tokens AS p(user_idx, token, expires) VALUES ($1, $2, $3) ' +
    'ON CONFLICT (user_idx) DO UPDATE SET token = $2, resend_count = p.resend_count + 1, expires = $3'
    const randomBytes = await this.asyncRandomBytes(32)
    const token = randomBytes.toString('hex')
    const expires = moment().add(1, 'day').toDate()
    const result = await tr.query(query, [userIdx, token, expires])
    return token
  }

  public async resetResendCountIfExpired(tr: Transaction, userIdx: number): Promise<void> {
    const query = 'UPDATE password_change_tokens SET resend_count = 0 WHERE user_idx = $1 AND expires <= now()'
    await tr.query(query, [userIdx])
  }

  public async getResendCount(tr: Transaction, token: string): Promise<number> {
    const query = 'SELECT resend_count FROM password_change_tokens WHERE token = $1'
    const result = await tr.query(query, [token])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].resend_count
  }

  public async removeToken(tr: Transaction, token: string): Promise<number> {
    const query = 'DELETE FROM password_change_tokens WHERE token = $1 RETURNING idx'
    const result = await tr.query(query, [token])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].idx
  }

  public async ensureTokenNotExpired(tr: Transaction, token: string): Promise<void> {
    const query = 'SELECT expires FROM password_change_tokens WHERE token = $1'
    const result = await tr.query(query, [token])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }

    const expires = result.rows[0].expires

    if (moment().isSameOrAfter(expires)) {
      throw new ExpiredTokenError()
    }
  }

  public async changePassword(tr: Transaction, userIdx: number, newPassword: string): Promise<number> {
    const passwordDigest = await argon2.hash(newPassword)
    const query = 'UPDATE users SET password_digest = $1 WHERE idx = $2 RETURNING idx'
    const result = await tr.query(query, [passwordDigest, userIdx])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].idx
  }

  public async changeShell(tr: Transaction, userIdx: number, shell: string): Promise<number> {
    const query = 'UPDATE users SET shell = $1 WHERE idx = $2 RETURNING idx'
    const result = await tr.query(query, [shell, userIdx])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    this.posixAccountsCache = null
    return result.rows[0].idx
  }

  public async getShell(tr: Transaction, userIdx: number): Promise<string> {
    const query = 'SELECT shell FROM users WHERE idx = $1'
    const result = await tr.query(query, [userIdx])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].shell
  }

  public async addUserMembership(tr: Transaction, userIdx: number, groupIdx: number): Promise<number> {
    const query = 'INSERT INTO user_memberships(user_idx, group_idx) VALUES ($1, $2) RETURNING idx'
    const result = await tr.query(query, [userIdx, groupIdx])
    return result.rows[0].idx
  }

  public async deleteUserMembership(tr: Transaction, userMembershipIdx: number): Promise<number> {
    const query = 'DELETE FROM user_memberships WHERE idx = $1 RETURNING idx'
    const result = await tr.query(query, [userMembershipIdx])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].idx
  }

  public async getAllUserMemberships(tr: Transaction, userIdx: number): Promise<Array<UserMembership>> {
    const query = 'SELECT user_idx, group_idx FROM user_memberships WHERE user_idx = $1'
    const result = await tr.query(query, [userIdx])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows.map(row => this.rowToUserMembership(row))
  }

  public async getUserReachableGroups(tr: Transaction, userIdx: number): Promise<Set<number>> {
    const userMemberships = await this.getAllUserMemberships(tr, userIdx)
    const groupSet = new Set<number>()

    for (const userMembership of userMemberships) {
      const reachableGroups = await this.model.groups.getGroupReachableArray(tr, userMembership.groupIdx)
      reachableGroups.forEach(gi => {
        groupSet.add(gi)
      })
    }

    return groupSet
  }

  public async getUserIdxByPasswordToken(tr: Transaction, token: string): Promise<number> {
    const query = 'SELECT user_idx FROM password_change_tokens WHERE token = $1'
    const result = await tr.query(query, [token])
    if (result.rows.length === 0) {
      throw new NoSuchEntryError()
    }
    return result.rows[0].user_idx
  }

  public async addStudentNumber(tr: Transaction, userIdx: number, studentNumber: string): Promise<number> {
    const query = 'INSERT INTO student_numbers(student_number, owner_idx) VALUES ($1, $2) RETURNING idx'
    const result = await tr.query(query, [studentNumber, userIdx])
    return result.rows[0].idx
  }

  private rowToUser(row: any): User {
    return {
      idx: row.idx,
      username: row.username,
      name: row.name,
      uid: row.uid,
      shell: row.shell,
      preferredLanguage: row.preferred_language,
    }
  }

  private rowToUserMembership(row: any): UserMembership {
    return {
      userIdx: row.user_idx,
      groupIdx: row.group_idx,
    }
  }

  private asyncRandomBytes(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.randomBytes(n, (err, buf) => {
        if (err) {
          reject(err)
          return
        }
        resolve(buf)
      })
    })
  }

  private usersToPosixAccounts(users: Array<User>): Array<ldap.SearchEntry<PosixAccount>> {
    const posixAccounts: Array<ldap.SearchEntry<PosixAccount>> = []
    users.forEach(user => {
      try {
        posixAccounts.push(this.userToPosixAccount(user))
      } catch (e) {
        // do nothing
      }
    })
    return posixAccounts
  }

  private userToPosixAccount(user: User): ldap.SearchEntry<PosixAccount> {
    if (user.username === null || user.shell === null) {
      throw new Error('Cannot convert to posixAccount')
    }
    return {
      dn: `cn=${user.username},${this.usersDN}`,
      attributes: {
        uid: user.username,
        cn: user.username,
        gecos: user.name,
        homeDirectory: `${this.model.config.posix.homeDirectoryPrefix}/${user.username}`,
        loginShell: user.shell,
        objectClass: posixAccountObjectClass,
        uidNumber: user.uid,
        gidNumber: this.model.config.posix.userGroupGid,
      },
    }
  }
}
