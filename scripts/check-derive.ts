import { mnemonicToMiniSecret, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";

const mnemonic = "race exchange sting tuition glow half subway upper mouse cradle oxygen aware";
const miniSecret = mnemonicToMiniSecret(mnemonic, "");
const derive = sr25519CreateDerive(miniSecret);

// Try //21 with prefix 42 (generic Substrate)
const wallet21 = derive("//21");
console.log(`//21 (prefix 42) => ${ss58Address(wallet21.publicKey, 42)}`);
console.log(`//21 (prefix 0)  => ${ss58Address(wallet21.publicKey, 0)}`);

// Try //wallet
const walletW = derive("//wallet");
console.log(`//wallet (42) => ${ss58Address(walletW.publicKey, 42)}`);

// Try no path (root)
const walletRoot = derive("");
console.log(`root (42) => ${ss58Address(walletRoot.publicKey, 42)}`);

console.log(`\nTarget: 5Cz3anXzwaanJJuD4LvTzPgink8QQeYj3tnc8oRbmtyTU6Ks`);
