import {readFile,writeFile} from 'node:fs/promises';
const key=(await readFile(process.argv[2],'utf8')).trim();
const decoded=Buffer.from(key,'base64').toString('utf8');
if(!decoded.startsWith('untrusted comment:')||!decoded.includes('\nRW'))throw Error('Not a Tauri public key');
const file=new URL('../src-tauri/tauri.conf.json',import.meta.url);const config=JSON.parse(await readFile(file,'utf8'));config.plugins.updater.pubkey=key;await writeFile(file,JSON.stringify(config,null,2)+'\n');
console.log('Updater public key embedded');
