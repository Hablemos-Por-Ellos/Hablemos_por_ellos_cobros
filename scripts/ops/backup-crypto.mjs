import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const MAGIC = Buffer.from("HPEBKP01");
const HEADER_BYTES = MAGIC.length + 32 + 12;

function keyFor(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 12) throw new Error("BACKUP_PASSPHRASE_TOO_SHORT");
  return crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function encryptBackup(input, output, passphrase) {
  return encryptBackupStream(fs.createReadStream(input), output, passphrase);
}

export async function encryptBackupStream(input, output, passphrase) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  cipher.setAAD(header);
  const target = fs.createWriteStream(output, { flags: "wx", mode: 0o600 });
  target.write(header);
  const hash = crypto.createHash("sha256");
  const digest = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(input, digest, cipher, target);
  await fs.promises.appendFile(output, cipher.getAuthTag());
  return hash.digest("hex");
}

export async function decryptBackupBuffer(input, passphrase) {
  const data = await fs.promises.readFile(input);
  if (data.length <= HEADER_BYTES + 16 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("INVALID_BACKUP_FILE");
  const header = data.subarray(0, HEADER_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(passphrase, header.subarray(8, 40)), header.subarray(40));
  decipher.setAAD(header);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES, -16)), decipher.final()]);
}

export async function decryptBackup(input, output, passphrase) {
  // Authenticate before writing, and never replace an existing destination.
  const data = await decryptBackupBuffer(input, passphrase);
  await fs.promises.writeFile(output, data, { flag: "wx", mode: 0o600 });
}

export async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
