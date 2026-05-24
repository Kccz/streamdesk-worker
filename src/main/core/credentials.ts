/**
 * worker token 存到系统钥匙串（macOS Keychain / Win Credential Manager / Linux libsecret）
 * 通过 keytar 库
 */
import keytar from 'keytar'

const SERVICE = 'cc.streamdesk.worker'
const ACCOUNT = 'worker-token'

export const credentials = {
  async get(): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE, ACCOUNT)
    } catch {
      return null
    }
  },
  async set(token: string): Promise<void> {
    await keytar.setPassword(SERVICE, ACCOUNT, token)
  },
  async clear(): Promise<void> {
    try {
      await keytar.deletePassword(SERVICE, ACCOUNT)
    } catch {
      /* ignore */
    }
  },
}
