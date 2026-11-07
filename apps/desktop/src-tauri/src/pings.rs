//! A running tray app polls independently of its WebView and panel visibility.
use crate::{companion::Companion, show_panel};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{collections::HashSet,sync::Mutex,time::Duration};
use tauri::{AppHandle,Emitter,Manager,State};

pub const AUMID: &str = "com.pulse.work";

#[derive(Default)]
pub struct Pings { pub snapshot:Mutex<Value>,pub error:Mutex<Option<String>>,pub issue:Mutex<Option<String>>,pub tray:Mutex<(String,String,String)> }
#[derive(Default,Serialize,Deserialize)]
struct Receipt { device:String,#[serde(default)] cursor:Option<String>,#[serde(default)] page:Option<String>,#[serde(default)] seen:Vec<String> }
fn same_device(app:&AppHandle,device:&str)->bool{app.state::<Companion>().session()["deviceId"].as_str()==Some(device)}
fn current_snapshot(app:&AppHandle)->Value{
 let snapshot=app.state::<Pings>().snapshot.lock().unwrap().clone();
 if snapshot["nativeDeviceId"].as_str().is_some_and(|device|same_device(app,device)){snapshot}else{Value::Null}
}
pub fn unread(app:&AppHandle)->u64 {current_snapshot(app)["counts"]["total"].as_u64().unwrap_or(0)}
fn status(app:&AppHandle,message:Option<String>){*app.state::<Pings>().error.lock().unwrap()=message;}
fn issue(app:&AppHandle,message:Option<String>){*app.state::<Pings>().issue.lock().unwrap()=message;}

/// What the person sees on a ping: the kind of update, never message text (lock screens show it).
pub fn ping_text(kind:&str)->&'static str{
 match kind{"chat"=>"New message in a conversation","mention"=>"You were mentioned","reply"=>"New reply in a thread","approval"=>"A request needs your decision","decision"=>"Your request was decided","policy"=>"A policy was updated","holiday"=>"Holiday update","payroll"=>"Salary credited","task"=>"New task for you","attendance"=>"Check in, break or check out: one tap","profile"=>"Finish your Pulse profile",_=>"A new work update is ready"}
}

#[tauri::command]
pub fn companion_ping_state(app:AppHandle,state:State<'_,Pings>)->Value{
 // Permission is local OS state. It must be accurate before pairing and while the server is offline too.
 let ping_issue=permission().err().or_else(||state.issue.lock().unwrap().clone());
 json!({"panelVisible":app.get_webview_window(crate::PANEL).is_some_and(|w|w.is_visible().unwrap_or(false)),"snapshot":current_snapshot(&app),"error":state.error.lock().unwrap().clone(),"pingIssue":ping_issue,"platform":crate::companion::platform()})
}
/// The banner's Fix button and Settings → Notifications: ask the OS properly, or open the exact OS settings page.
#[tauri::command]
pub async fn companion_ping_fix(app:AppHandle)->Result<Value,String>{
 #[cfg(target_os="macos")]
 { let _=mac_usernotifications::request_auth().await; }
 #[cfg(windows)]
 register_aumid();
 match permission(){
  Ok(())=>{issue(&app,None);
   // The first toast also adds Pulse to Windows' notification settings list.
   #[cfg(windows)]
   { let _=tauri_winrt_notification::Toast::new(AUMID).title("Pulse").text1("Pings are on. Work updates will appear here.").show(); }
   Ok(json!({"ok":true}))}
  Err(problem)=>{
   #[cfg(target_os="macos")]
   let _=crate::open_url("x-apple.systempreferences:com.apple.preference.notifications");
   #[cfg(windows)]
   let _=crate::open_url("ms-settings:notifications");
   issue(&app,Some(problem.clone()));Ok(json!({"ok":false,"message":problem,"openedSettings":true}))
  }
 }
}
/// Kept for older panels: same as Fix.
#[tauri::command]
pub async fn companion_ping_enable(app:AppHandle)->Result<(),String>{
 let r=companion_ping_fix(app).await?;if r["ok"]==true{Ok(())}else{Err(r["message"].as_str().unwrap_or("Notifications are off for Pulse").to_string())}
}

/// Ok unless the OS clearly says pings are blocked. "Cannot tell yet" is not an error: Windows only lists an
/// unpackaged app in its notification settings after the first toast, and asking earlier fails.
pub fn permission()->Result<(),String>{
 #[cfg(target_os="macos")]
 {
  if let Ok(settings)=mac_usernotifications::blocking::get_notification_settings(){
   match settings.authorization_status{
    mac_usernotifications::AuthorizationStatus::Denied=>return Err("Pings are turned off for Pulse in macOS. Press Fix, then allow Pulse in Notifications.".into()),
    mac_usernotifications::AuthorizationStatus::NotDetermined=>return Err("Turn on pings so new messages and approvals reach you on this Mac.".into()),
    _=>{}
   }
  }
 }
 #[cfg(windows)]
 {
  use windows::{core::HSTRING,UI::Notifications::{ToastNotificationManager,NotificationSetting}};
  if let Ok(notifier)=ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID)){
   match notifier.Setting(){
    Ok(NotificationSetting::DisabledForApplication)=>return Err("Pings are turned off for Pulse in Windows. Press Fix, then turn Pulse on in Notifications.".into()),
    Ok(NotificationSetting::DisabledForUser)=>return Err("Windows notifications are turned off. Press Fix, then turn Notifications on.".into()),
    Ok(NotificationSetting::DisabledByGroupPolicy)|Ok(NotificationSetting::DisabledByManifest)=>return Err("Your computer’s policy blocks notifications. Ask IT to allow Pulse.".into()),
    _=>{}
   }
  }
 }
 Ok(())
}

/// Registers Pulse's toast identity for this Windows user (no admin rights): display name and icon, so toasts
/// say "Pulse" with the Pulse icon on per-user installs too.
#[cfg(windows)]
pub fn register_aumid(){
 use std::os::windows::process::CommandExt;
 let icon=std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).map(|d|d.join("com.pulse.work").join("toast-icon.png"));
 if let Some(icon)=&icon{if let Some(dir)=icon.parent(){let _=std::fs::create_dir_all(dir);}let _=std::fs::write(icon,include_bytes!("../icons/128x128.png"));}
 let key=format!("HKCU\\Software\\Classes\\AppUserModelId\\{AUMID}");
 let mut values=vec![("DisplayName".to_string(),"Pulse".to_string()),("IconBackgroundColor".to_string(),"FF5B45D6".to_string())];
 if let Some(icon)=icon{values.push(("IconUri".into(),icon.to_string_lossy().to_string()));}
 for (name,value) in values{
  // CREATE_NO_WINDOW: no console flashes on screen.
  let _=std::process::Command::new("reg").args(["add",&key,"/v",&name,"/t","REG_SZ","/d",&value,"/f"]).creation_flags(0x0800_0000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
 }
}
#[cfg(not(windows))]
pub fn register_aumid(){}

fn clicked(app:AppHandle,device:String,row:Value){
 tauri::async_runtime::spawn_blocking(move||{
  if app.state::<Companion>().session()["deviceId"].as_str()!=Some(device.as_str()){
   show_panel(&app);let _=app.emit("pulse:open-conversation",json!({"error":"This ping belongs to another account. Switch back to that account to open it."}));return;
  }
  let channel=row["channelId"].as_str();
  let path=channel.map(|id|format!("chats/{id}/messages")).unwrap_or_else(||format!("companion/inbox?id={}",row["id"].as_str().unwrap_or_default()));
  let result=app.state::<Companion>().request(&path,None);
  match result{
   Ok(data)=>{
    if channel.is_none(){
     if !data["rows"].as_array().is_some_and(|rows|rows.iter().any(|n|n["id"]==row["id"])){return;}
     // Attendance questions ("Check in?", reminders) open the quick panel, where the answer is one click.
     if row["kind"].as_str()==Some("attendance"){show_panel(&app);let _=app.state::<Companion>().request("companion/read",Some(json!({"id":row["id"]})));return;}
     // Requests, policies and other pages open where they live, in the Pulse window.
     if let Some(href)=row["href"].as_str().and_then(crate::appwin::safe_path){crate::appwin::open(&app,Some(href));let _=app.state::<Companion>().request("companion/read",Some(json!({"id":row["id"]})));return;}
    }
    show_panel(&app);
    let _=app.emit("pulse:open-conversation",json!({"channelId":channel,"notificationId":row["id"],"href":row["href"]}));
   }
   Err(_)=>{show_panel(&app);let _=app.emit("pulse:open-conversation",json!({"error":"You are not a member of this conversation with this account, or your sign-in has expired."}));}
  }
 });
}
fn send(app:&AppHandle,device:&str,row:&Value)->Result<(),String>{
 if !same_device(app,device){return Ok(());}
 permission()?;
 let text=ping_text(row["kind"].as_str().unwrap_or("update"));
 #[cfg(windows)]
 {
  use tauri_winrt_notification::{Toast,Sound};
  let handle=app.clone();let device=device.to_owned();let row=row.clone();
  Toast::new(AUMID).title("Pulse").text1(text).sound(Some(Sound::Default))
   .on_activated(move |_|{clicked(handle.clone(),device.clone(),row.clone());Ok(())})
   .show().map_err(|_|"Windows could not show a Pulse ping. Press Fix to check Notifications.".to_string())?;
 }
 #[cfg(target_os="macos")]
 {
  let handle=app.clone();let device=device.to_owned();let row=row.clone();
  // Awaiting response uses an async task, not a thread per ping. AppKit owns the main run loop.
  tauri::async_runtime::spawn(async move{
   if !same_device(&handle,&device){return;}
   let result=mac_usernotifications::Notification::new().title("Pulse").message(text).sound(mac_usernotifications::sound::DEFAULT)
     .timeout(Duration::from_secs(86400)).send().await;
   match result{
    Ok(notification)=>{if let Ok(response)=notification.response().await{if response.is_default_action(){clicked(handle,device,row);}}}
    Err(_)=>issue(&handle,Some("macOS could not show a Pulse ping. Press Fix to check Notifications.".into())),
   }
  });
 }
 #[cfg(not(any(windows,target_os="macos")))]
 {let _=(app,device,row,text);}
 Ok(())
}
pub fn start(app:AppHandle){
 register_aumid();
 let path=app.path().app_local_data_dir().ok().map(|p|p.join("notification-receipt.json"));
 let mut receipt=path.as_ref().and_then(|p|std::fs::read(p).ok()).and_then(|b|serde_json::from_slice::<Receipt>(&b).ok()).unwrap_or_default();
 let _=std::thread::Builder::new().name("pulse-chat-pings".into()).spawn(move||'poll:loop{
  let device=app.state::<Companion>().session()["deviceId"].as_str().map(str::to_owned);
  if let Some(device)=device{
   if receipt.device!=device{receipt=Receipt{device:device.clone(),..Default::default()};}
   let mut params=url::form_urlencoded::Serializer::new(String::new());
   if let Some(cursor)=&receipt.cursor{params.append_pair("since",cursor);}
   if let Some(page)=&receipt.page{params.append_pair("page",page);}
   let query=format!("?{}",params.finish());
   match app.state::<Companion>().request(&format!("companion/updates{query}"),None){
    Ok(mut snapshot)=>{
     if app.state::<Companion>().session()["deviceId"].as_str()==Some(device.as_str()){
      status(&app,None);issue(&app,permission().err());
      let mut seen:HashSet<String>=receipt.seen.iter().cloned().collect();
      if let Some(rows)=snapshot["rows"].as_array(){for row in rows{
       if !same_device(&app,&device){continue 'poll;}
       if let Some(id)=row["id"].as_str(){if seen.insert(id.into()){
        receipt.seen.push(id.into());
        if row["pingAllowed"].as_bool()==Some(true){if let Err(error)=send(&app,&device,row){issue(&app,Some(error));}}
       }}
      }}
      if let Some(rows)=snapshot["rows"].as_array(){let ids:Vec<_>=rows.iter().filter_map(|r|r["id"].as_str()).collect();if !ids.is_empty(){let _=app.state::<Companion>().request("companion/ack",Some(json!({"ids":ids})));}}
      if !same_device(&app,&device){continue 'poll;}
      receipt.page=snapshot["page"].as_str().map(str::to_owned);
      receipt.cursor=snapshot["cursor"].as_str().map(str::to_owned);
      if receipt.seen.len()>2000{receipt.seen.drain(..receipt.seen.len()-2000);}
      snapshot["nativeDeviceId"]=json!(device);
      *app.state::<Pings>().snapshot.lock().unwrap()=snapshot;
      if let Some(path)=&path{if let Ok(bytes)=serde_json::to_vec(&receipt){let temporary=path.with_extension("tmp");if std::fs::write(&temporary,bytes).is_ok(){let _=std::fs::rename(temporary,path);}}}
      crate::set_tray(app.clone(),String::new(),"neutral".into(),"Pulse".into());
     }
    }
    Err(error)=>{if same_device(&app,&device){status(&app,Some(error.message));}},
   }
  }else{
   *app.state::<Pings>().snapshot.lock().unwrap()=Value::Null;
   crate::set_tray(app.clone(),String::new(),"neutral".into(),"Pulse".into());
   receipt=Receipt::default();if let Some(path)=&path{let _=std::fs::write(path,b"{}");}
  }
  std::thread::sleep(Duration::from_secs(3));
 });
}

// Small white numerals on a red corner badge, visible in Windows' tray overflow too.
const DIGITS:[u16;10]=[0b111101101101111,0b010110010010111,0b111001111100111,0b111001111001111,0b101101111001001,0b111100111001111,0b111100111101111,0b111001001001001,0b111101111101111,0b111101111001111];
fn draw_digits(rgba:&mut [u8],w:u32,h:u32,text:&str,left:u32,top:u32,scale:u32){
 for (n,c) in text.chars().enumerate(){let bits=DIGITS[c.to_digit(10).unwrap_or(0)as usize];for y in 0..5{for x in 0..3{
  if bits&(1<<(14-y*3-x))==0{continue;}
  for dy in 0..scale{for dx in 0..scale{let px=left+(n as u32*4+x)*scale+dx;let py=top+y*scale+dy;if px<w&&py<h{let i=((py*w+px)*4)as usize;rgba[i..i+4].copy_from_slice(&[255,255,255,255]);}}}
 }}}
}
#[cfg(not(target_os="macos"))]
pub fn badge_icon(icon:tauri::image::Image<'_>,count:u64)->tauri::image::Image<'static>{
 let (w,h)=(icon.width(),icon.height());let mut rgba=icon.rgba().to_vec();
 let scale=(w/24).max(1);let text=count.min(99).to_string();let width=(text.len() as u32*4+2)*scale;let start=w.saturating_sub(width);
 for y in 0..(7*scale).min(h){for x in start..w{let i=((y*w+x)*4)as usize;rgba[i..i+4].copy_from_slice(&[211,48,64,255]);}}
 draw_digits(&mut rgba,w,h,&text,start+scale,scale,scale);
 tauri::image::Image::new_owned(rgba,w,h)
}
/// The taskbar overlay on the Pulse window: a red disc with the unread count ("9+" above nine).
#[cfg(windows)]
pub fn overlay_icon(count:u64)->tauri::image::Image<'static>{
 let (w,h)=(32u32,32u32);let mut rgba=vec![0u8;(w*h*4) as usize];
 for y in 0..h{for x in 0..w{let (dx,dy)=(x as f32-15.5,y as f32-15.5);let d=(dx*dx+dy*dy).sqrt();if d<=15.5{let a=if d>14.5{((15.5-d)*255.0) as u8}else{255};let i=((y*w+x)*4) as usize;rgba[i..i+4].copy_from_slice(&[211,48,64,a]);}}}
 let text=if count>9{"9".to_string()}else{count.to_string()};
 let scale=4u32;let width=(text.len() as u32*4-1)*scale;
 draw_digits(&mut rgba,w,h,&text,(w-width)/2,(h-5*scale)/2,scale);
 tauri::image::Image::new_owned(rgba,w,h)
}

#[cfg(test)]
mod tests{
 use super::*;
 #[test]
 fn ping_text_never_contains_message_content(){
  for kind in ["chat","mention","reply","approval","decision","policy","holiday","payroll","task","attendance","profile","update","unknown"]{assert!(ping_text(kind).len()<60);}
  assert_eq!(ping_text("chat"),"New message in a conversation");
 }
}
