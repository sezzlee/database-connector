import process from "node:process";
import { generateCredentialKeyPair } from "../dist/seal.js";

const pair = await generateCredentialKeyPair();
process.stdout.write(
  `${JSON.stringify(
    {
      VITE_CHAT_DATABASE_CREDENTIAL_PUBLIC_KEY: pair.publicKey,
      CHAT_DATABASE_MANAGED_CREDENTIAL_KIDS: pair.keyId,
      CHAT_DATABASE_EXECUTOR_CREDENTIAL_KEYS: JSON.stringify([pair.privateKey]),
    },
    null,
    2,
  )}\n`,
);
