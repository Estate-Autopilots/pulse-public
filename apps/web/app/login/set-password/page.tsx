import { headers } from 'next/headers';
import { SetPasswordForm } from './form';
import { getBranding } from '../../lib/branding';
import { hostMode, requestHost } from '../../lib/host-mode.mjs';
// UX-TENANT: the company whose address this is names the page (its admin's invitation link opens here); the install's
// own addresses use the install's name (EST-655).
export default async function SetPasswordPage() { const [mode,branding]=await Promise.all([hostMode(requestHost(await headers())),getBranding()]); return <SetPasswordForm companyName={mode.name??branding.name}/>; }
