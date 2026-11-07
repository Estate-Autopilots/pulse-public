import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json','utf8'));
if(config.plugins?.updater?.pubkey==='UNPROVISIONED'||!config.plugins?.updater?.pubkey||!config.bundle.createUpdaterArtifacts)throw Error('Updater public key is not provisioned');
for(const name of ['TAURI_SIGNING_PRIVATE_KEY','ANDROID_SIGNING_STORE_BASE64','ANDROID_SIGNING_PASSWORD','MACOS_SIGNING_P12_BASE64','MACOS_SIGNING_P12_PASSWORD'])if(!process.env[name])throw Error(`Missing Actions secret ${name}`);
console.log('Release signing configuration present');
