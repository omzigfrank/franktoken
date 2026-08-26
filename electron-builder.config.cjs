// electron-builder config. Static settings live in package.json's "build"
// block; this file layers on Windows code signing ONLY when the corresponding
// secrets are present in the environment.
//
// Why signing matters: an unsigned .exe has no publisher identity, so Edge
// warns on download ("isn't commonly downloaded") and SmartScreen warns again
// on first run. No amount of packaging config fixes that — it needs a
// certificate tied to a real identity. Two supported routes:
//
//   1. Azure Trusted Signing (cheapest publicly-trusted option). Set
//      AZURE_TRUSTED_SIGNING_ENDPOINT / _ACCOUNT / _PROFILE plus the standard
//      AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
//   2. A traditional certificate file. Set CSC_LINK (path or base64 .pfx) and
//      CSC_KEY_PASSWORD — electron-builder reads those directly, so this file
//      needs no branch for it. NOTE: CSC_LINK must be absent, not empty. The
//      macOS target resolves an empty value against the working directory and
//      fails with "<repo root> not a file", so CI only exports it when set.
//
// With neither configured the build stays unsigned and still succeeds, so
// local builds and forks are unaffected.
const { build } = require('./package.json')

const endpoint = process.env.AZURE_TRUSTED_SIGNING_ENDPOINT
const account = process.env.AZURE_TRUSTED_SIGNING_ACCOUNT
const profile = process.env.AZURE_TRUSTED_SIGNING_PROFILE

const azure =
  endpoint && account && profile
    ? {
        azureSignOptions: {
          endpoint,
          codeSigningAccountName: account,
          certificateProfileName: profile
        }
      }
    : {}

if (Object.keys(azure).length) {
  console.log(`[franktoken] signing Windows artifacts via Azure Trusted Signing (${account}/${profile})`)
} else if (process.env.CSC_LINK) {
  console.log('[franktoken] signing Windows artifacts with the certificate in CSC_LINK')
} else {
  console.log('[franktoken] no signing secrets set — producing UNSIGNED artifacts')
}

module.exports = { ...build, win: { ...build.win, ...azure } }
