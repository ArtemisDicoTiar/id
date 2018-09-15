import test from 'ava'
import * as request from 'supertest'
import * as nodemailer from 'nodemailer'
import * as uuid from 'uuid/v4'
import { app, model, config } from '../setup'

test.skip('email configuration is correct', async t => {
  const emailOption = {
    host: config.email.host,
    port: 465,
    secure: true,
    auth: {
      user: config.email.username,
      pass: config.email.password,
    },
  }
  const transport = nodemailer.createTransport(emailOption)
  await transport.verify()
  t.pass()
})

test('check token api', async t => {
  let token: string = ''
  const local = uuid()
  const domain = uuid()

  await model.pgDo(async tr => {
    const emailAddressIdx = await model.emailAddresses.create(tr, local, domain)
    await model.emailAddresses.generateVerificationToken(tr, emailAddressIdx)
    const result = await tr.query('SELECT token FROM email_verification_tokens WHERE email_idx = $1', [emailAddressIdx])

    token = result.rows[0].token
  })

  const agent = request.agent(app)

  let response

  response = await agent.post('/api/email/check-token').send({
    token: token + 'doge',
  })
  t.is(response.status, 400)

  response = await agent.post('/api/email/check-token').send({
    token,
  })
  t.is(response.status, 200)
  t.deepEqual(response.body, { emailLocal: local, emailDomain: domain })
})

test('test email validation', async t => {
  const agent = request.agent(app)

  let response

  response = await agent.post('/api/email/verify').send({
    emailLocal: 'bad@example.com, example',
    emailDomain: 'snu.ac.kr',
  })
  t.is(response.status, 400)

  response = await agent.post('/api/email/verify').send({
    emailLocal: 'example',
    emailDomain: 'example.com',
  })
  t.is(response.status, 400)

  response = await agent.post('/api/email/verify').send({
    emailLocal: 'example',
    emailDomain: 'snu.ac.kr',
  })
  t.is(response.status, 200)
})
