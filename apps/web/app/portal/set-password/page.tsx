import {headers} from 'next/headers';
import {SetPasswordForm} from '../../login/set-password/form';
import {getBranding} from '../../lib/branding';
import {hostMode,requestHost} from '../../lib/host-mode.mjs';
// The company whose address this is (UX-TENANT), else the install's name (EST-655).
export default async function Page(){const [mode,branding]=await Promise.all([hostMode(requestHost(await headers())),getBranding()]);return <SetPasswordForm client companyName={mode.name??branding.name}/>;}
