import { readFileSync } from 'node:fs';
const common = new Set(readFileSync(new URL('../data/common-passwords.txt', import.meta.url), 'utf8').split(/\r?\n/).map(p => p.trim().toLowerCase()));
export function passwordError(password: string): string | null {
 const size=Buffer.byteLength(password,'utf8');
 if(size<10||size>72)return size<10?'Use at least 10 characters (several unrelated words work well).':'Use at most 72 characters (fewer if you use emoji or non-Latin letters).';
 if((common.has(password.toLowerCase())||common.has(password.toLowerCase().replace(/[0-9!@#$%^&*]+$/,'')))||/^(.)\1+$/.test(password))return 'This password is too common or a repeated character (like password123 or aaaaaaaaaa). Choose a longer, unique passphrase.';
 return null;
}
export function deviceLabel(ua: string): string {
 const os=/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iOS':/Windows/.test(ua)?'Windows':/Macintosh|Mac OS/.test(ua)?'macOS':/Linux/.test(ua)?'Linux':'Unknown OS';
 const browser=/Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Browser';
 return `${browser} · ${os}`;
}
export function base32(hex: string): string {
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,out='';
 for(const byte of Buffer.from(hex,'hex')){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}
 if(bits)out+=alphabet[(value<<(5-bits))&31];return out;
}
