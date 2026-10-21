import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const valid = value => /^[a-f0-9]{64}$/.test(value);
export async function loadIdentity(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 128) throw new Error('Invalid identity file');
    const token = (await handle.readFile('utf8')).trim();
    if (!valid(token)) throw new Error('Invalid identity file');
    return token;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally { await handle?.close(); }
}
export async function saveIdentity(file, token) {
  if (!valid(token)) throw new Error('Invalid identity');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(token + '\n');
  } catch (error) {
    if (error.code !== 'EEXIST' || await loadIdentity(file) !== token) throw new Error('Identity file already exists or is not private');
  } finally { await handle?.close(); }
}
