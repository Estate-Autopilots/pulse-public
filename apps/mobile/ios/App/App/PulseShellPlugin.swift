import AVFoundation
import Capacitor
import CoreLocation
import Foundation
import SafariServices
import Security
import UIKit
import UserNotifications

/// The Pulse web app inside the iPhone shell: swipe back through Pulse, the theme follows the page, and the
/// PulseShell bridge is registered. Navigation outside Pulse opens in Safari (Capacitor's allowlist).
class ShellViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PulseShellPlugin())
        webView?.allowsBackForwardNavigationGestures = true
        webView?.allowsLinkPreview = false
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
    }
}

/// The same small bridge as Android (apps/web/app/lib/native-shell.ts feature-detects it). The iPhone build has no
/// Apple account yet: Wi-Fi names, real push and installable updates wait for it, and the bridge says so.
@objc(PulseShellPlugin)
public class PulseShellPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "PulseShellPlugin"
    public let jsName = "PulseShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startEnrollment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishEnrollment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSpeaker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presencePreferences", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wifi", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "location", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openInstallSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise),
        // POLISH-1: Capacitor dispatches its permission methods only when listed (else the page's promise never settles).
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
    ]

    static let base = "https://pulse.estateautopilots.com/api/native/v0/"
    private var pairing: [String: Any]?
    private var pairingAt = Date.distantPast
    private var access: String?
    private var accessUntil = Date.distantPast
    private let credentialLock = NSLock()
    private var credentialGeneration = 0
    private var refreshing = false
    private var tokenWaiters: [(String?) -> Void] = []
    private var locator: CLLocationManager?
    /// PRESENCE-ONBOARD: iOS watches circular regions around the person's offices (with "Always", asked on a tap).
    private var regions: CLLocationManager?
    private var locationCall: CAPPluginCall?
    private var locationTimeout: DispatchWorkItem?
    private var permissionCall: CAPPluginCall?

    // MARK: Keychain (this device only, readable after the first unlock)
    private let service = "com.pulse.work.mobile.shell"

    private func keychainSet(_ key: String, _ value: String?) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
        guard let value = value else { return }
        var add = query
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private func keychainGet(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// JSON null for a missing value (an Optional inside Any is not a JavaScript value).
    private func orNull(_ value: String?) -> Any {
        if let value = value { return value }
        return NSNull()
    }

    private var enrolled: Bool { keychainGet("refresh") != nil && keychainGet("device") != nil }

    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.1.4" }

    // MARK: Gateway
    private func gateway(_ path: String, _ body: [String: Any]?, bearer: String? = nil, done: @escaping (Int, [String: Any]) -> Void) {
        guard let url = URL(string: PulseShellPlugin.base + path) else { return done(0, [:]) }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("PulseShell/\(version) (ios)", forHTTPHeaderField: "User-Agent")
        if let bearer = bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            done(status, json)
        }.resume()
    }

    private func accessToken(_ done: @escaping (String?) -> Void) {
        credentialLock.lock()
        if let access = access, Date() < accessUntil.addingTimeInterval(-60) { credentialLock.unlock(); return done(access) }
        guard let refresh = keychainGet("refresh") else { credentialLock.unlock(); return done(nil) }
        tokenWaiters.append(done)
        if refreshing { credentialLock.unlock(); return }
        refreshing = true
        let generation = credentialGeneration
        credentialLock.unlock()
        // Refresh credentials are single-use. Concurrent Settings/location calls share one rotation.
        gateway("native/refresh", ["refreshToken": refresh]) { status, json in
            self.credentialLock.lock()
            // A sign-out or replacement enrollment must never be undone by an older refresh response.
            guard generation == self.credentialGeneration else { self.credentialLock.unlock(); return }
            var result: String?
            if status == 200, let next = json["refreshToken"] as? String, let token = json["accessToken"] as? String {
                self.keychainSet("refresh", next)
                self.access = token
                self.accessUntil = Date().addingTimeInterval(TimeInterval((json["expiresIn"] as? Int) ?? 900))
                result = token
            } else if status == 401 {
                for key in ["refresh", "device", "person"] { self.keychainSet(key, nil) }
                self.access = nil
                self.accessUntil = .distantPast
                self.credentialGeneration += 1
            }
            let waiters = self.tokenWaiters
            self.tokenWaiters = []
            self.refreshing = false
            self.credentialLock.unlock()
            waiters.forEach { $0(result) }
        }
    }

    private func forget() {
        credentialLock.lock()
        for key in ["refresh", "device", "person"] { keychainSet(key, nil) }
        access = nil
        accessUntil = .distantPast
        credentialGeneration += 1
        refreshing = false
        let waiters = tokenWaiters
        tokenWaiters = []
        credentialLock.unlock()
        waiters.forEach { $0(nil) }
    }

    // MARK: Bridge
    @objc func info(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve([
                "platform": "ios", "version": self.version, "build": Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 1001001,
                "enrolled": self.enrolled, "deviceId": self.orNull(self.keychainGet("device")), "personId": self.orNull(self.keychainGet("person")),
                "notifications": settings.authorizationStatus == .authorized, "pushReady": false, "pushActive": false,
                // POLISH-1: iOS asks once; after that only Settings → Pulse → Notifications can turn them on.
                "notificationsAsk": settings.authorizationStatus == .notDetermined ? "prompt" : [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) ? "granted" : "denied",
            ])
        }
    }

    @objc func status(_ call: CAPPluginCall) { info(call) }

    @objc func startEnrollment(_ call: CAPPluginCall) {
        let name = "Pulse app · \(UIDevice.current.model)"
        gateway("native/pair/start", ["platform": "ios", "name": name]) { status, json in
            guard status == 200, let code = json["code"] as? String else { return call.reject("Pulse could not start registering this phone. Check your connection.", "start") }
            self.pairing = json
            self.pairingAt = Date()
            call.resolve(["code": code, "replaces": self.orNull(self.keychainGet("device"))])
        }
    }

    @objc func finishEnrollment(_ call: CAPPluginCall) {
        guard let p = pairing, Date().timeIntervalSince(pairingAt) < 540, let pairId = p["pairId"], let secret = p["pollSecret"] else {
            return call.reject("Start registering this phone again.", "expired")
        }
        func poll(_ attempt: Int) {
            gateway("native/pair/poll", ["pairId": pairId, "pollSecret": secret]) { status, json in
                let state = json["status"] as? String
                if status == 200, state == "approved", let refresh = json["refreshToken"] as? String, let device = json["deviceId"] as? String {
                    self.forget()
                    self.credentialLock.lock()
                    self.keychainSet("refresh", refresh)
                    self.keychainSet("device", device)
                    self.keychainSet("person", (json["person"] as? [String: Any])?["id"] as? String)
                    self.access = json["accessToken"] as? String
                    self.accessUntil = Date().addingTimeInterval(840)
                    self.credentialLock.unlock()
                    self.pairing = nil
                    return call.resolve(["deviceId": device])
                }
                if state == "pending", attempt < 6 {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { poll(attempt + 1) }
                } else {
                    call.reject("This phone was not approved. Sign in again to register it.", "denied")
                }
            }
        }
        poll(0)
    }

    @objc func signOut(_ call: CAPPluginCall) {
        stopOffices()
        guard enrolled, let device = keychainGet("device") else { forget(); return call.resolve() }
        accessToken { token in
            guard let token = token else { self.forget(); return call.resolve() }
            self.gateway("devices/\(device)/revoke", [:], bearer: token) { _, _ in
                self.forget()
                self.setBadgeCount(0)
                call.resolve()
            }
        }
    }

    /// Settings → Notifications → Turn on: iOS's own prompt, then a confirmation notification.
    @objc func requestNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted {
                let content = UNMutableNotificationContent()
                content.title = "Notifications are on"
                content.body = "New messages, requests waiting for you and decisions on yours will appear here."
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "pulse-notifications-on", content: content, trigger: nil))
            }
            call.resolve(["state": granted ? "granted" : "denied"])
        }
    }

    /// iPhone background checks and real push need the Apple account; while Pulse is open the page keeps the badge.
    @objc func checkInbox(_ call: CAPPluginCall) { call.resolve() }

    private func setBadgeCount(_ count: Int) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count, withCompletionHandler: nil)
        } else {
            DispatchQueue.main.async { UIApplication.shared.applicationIconBadgeNumber = count }
        }
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        setBadgeCount(max(0, call.getInt("count") ?? 0))
        call.resolve()
    }

    /// CHAT-VOICE: a call's audio on the loudspeaker or the earpiece, as on Android (READY: the iPhone bridge lacked it).
    @objc func setSpeaker(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? true
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.overrideOutputAudioPort(on ? .speaker : .none)
            call.resolve(["on": on])
        } catch {
            call.reject("The speaker could not be switched")
        }
    }

    @objc func setTheme(_ call: CAPPluginCall) {
        let dark = call.getBool("dark") ?? false
        DispatchQueue.main.async {
            self.bridge?.viewController?.overrideUserInterfaceStyle = dark ? .dark : .light
            let canvas = dark ? UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x19 / 255, alpha: 1) : UIColor(red: 0xF6 / 255, green: 0xF6 / 255, blue: 0xFA / 255, alpha: 1)
            self.bridge?.webView?.backgroundColor = canvas
            self.bridge?.viewController?.view.backgroundColor = canvas
            call.resolve()
        }
    }

    @objc func setPushToken(_ call: CAPPluginCall) {
        call.reject("Pings on iPhone need Pulse's Apple account first.", "unsupported")
    }

    /// Reading the Wi-Fi name on iPhone needs the "Access Wi-Fi Information" entitlement of a signed build.
    @objc func presencePreferences(_ call: CAPPluginCall) {
        accessToken { token in
            guard let token = token else { return call.reject("Sign in to register this phone first.", "presence") }
            let read = {
                self.gateway("companion/presence", nil, bearer: token) { status, json in
                    guard status == 200 else { return call.reject("Pulse could not read your office presence choice. Try again.", "presence") }
                    DispatchQueue.main.async {
                        // What iOS lets Pulse notice, as on Android: the office area needs "Always".
                        let state = (self.regions ?? CLLocationManager()).authorizationStatus
                        var out = json
                        out["arrival"] = ["location": state == .authorizedWhenInUse || state == .authorizedAlways, "background": state == .authorizedAlways]
                        call.resolve(out)
                    }
                }
            }
            if let enabled = call.getBool("enabled") {
                self.gateway("companion/presence", ["consent": enabled, "autoConsent": false, "consentOnly": true], bearer: token) { status, _ in
                    guard status == 200 else { return call.reject("Pulse could not save your office presence choice. Try again.", "presence") }
                    // POLISH-1: iOS is asked in two steps by the page (while using, then "Always" with Pulse's own
                    // explanation), through requestPermissions; turning helpers on asks nothing by itself.
                    self.monitorOffices()
                    read()
                }
            } else { self.monitorOffices(); read() }
        }
    }

    /// A region event can relaunch Pulse in the background: a manager with a delegate must exist at once to receive it.
    override public func load() {
        DispatchQueue.main.async {
            let manager = CLLocationManager()
            manager.delegate = self
            self.regions = manager
            if self.enrolled { self.monitorOffices() }
        }
    }

    // MARK: Office arrival (PRESENCE-ONBOARD)
    /// Regions around the person's offices, only while they agree. iOS wakes Pulse on entering or leaving; Pulse sends
    /// "entered/left office X" to the server, which asks "Check in?" or, with HR's setting and two signals, checks in.
    /// Never a position, never a journey; check-out is never automatic.
    private func monitorOffices() {
        accessToken { token in
            guard let token = token else { return self.stopOffices() }
            self.gateway("companion/presence", nil, bearer: token) { status, json in
                DispatchQueue.main.async {
                    guard status == 200, json["enabled"] as? Bool == true, let offices = json["offices"] as? [[String: Any]] else { return self.stopOffices() }
                    let manager = self.regions ?? CLLocationManager()
                    manager.delegate = self
                    self.regions = manager
                    guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self), manager.authorizationStatus == .authorizedAlways else { return }
                    for region in manager.monitoredRegions where region.identifier.hasPrefix("office:") { manager.stopMonitoring(for: region) }
                    for office in offices.prefix(15) {
                        let number = { (key: String) -> Double? in (office[key] as? Double) ?? (office[key] as? String).flatMap(Double.init) }
                        guard let id = office["id"] as? String, let lat = number("lat"), let lng = number("lng") else { continue }
                        let radius = min(max(number("radius") ?? 150, 100), manager.maximumRegionMonitoringDistance)
                        let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), radius: radius, identifier: "office:\(id)")
                        region.notifyOnEntry = true
                        region.notifyOnExit = true
                        manager.startMonitoring(for: region)
                    }
                }
            }
        }
    }

    private func stopOffices() {
        DispatchQueue.main.async {
            guard let manager = self.regions else { return }
            for region in manager.monitoredRegions where region.identifier.hasPrefix("office:") { manager.stopMonitoring(for: region) }
        }
    }

    public func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) { officeEvent(region, "enter") }
    public func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) { officeEvent(region, "exit") }

    private func officeEvent(_ region: CLRegion, _ kind: String) {
        guard region.identifier.hasPrefix("office:") else { return }
        let office = String(region.identifier.dropFirst("office:".count))
        accessToken { token in
            guard let token = token else { return }
            // The choice is read again first: a withdrawal elsewhere stops this phone before anything is sent.
            self.gateway("companion/presence", nil, bearer: token) { status, json in
                guard status == 200, json["enabled"] as? Bool == true else { return self.stopOffices() }
                self.gateway("companion/presence", ["officeId": office, "region": kind, "consent": true, "autoConsent": json["auto"] as? Bool ?? false], bearer: token) { _, _ in }
            }
        }
    }

    // MARK: Permissions (POLISH-1)
    /// Location while using Pulse (office Wi-Fi and a tap), then "Always" (office arrival with Pulse closed).
    private func permissionStates() -> [String: Any] {
        let state = (regions ?? CLLocationManager()).authorizationStatus
        let location = state == .authorizedWhenInUse || state == .authorizedAlways ? "granted" : state == .notDetermined ? "prompt" : "denied"
        let background = state == .authorizedAlways ? "granted" : state == .denied || state == .restricted ? "denied" : "prompt"
        return ["location": location, "background": background]
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.permissionStates()) }
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let wanted = call.getArray("permissions", String.self) ?? ["location"]
        DispatchQueue.main.async {
            let manager = self.regions ?? CLLocationManager()
            manager.delegate = self
            self.regions = manager
            let before = manager.authorizationStatus
            self.permissionCall = call
            if wanted.contains("background") { manager.requestAlwaysAuthorization() } else { manager.requestWhenInUseAuthorization() }
            // iOS answers through the delegate when it asked; when it did not ask (already decided), nothing arrives,
            // so the answer is the state once Pulse is still in front after a moment.
            func settle(_ waited: Double) {
                guard let pending = self.permissionCall, pending === call else { return }
                if manager.authorizationStatus != before || (waited >= 1.5 && UIApplication.shared.applicationState == .active) || waited >= 120 {
                    self.permissionCall = nil
                    pending.resolve(self.permissionStates())
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { settle(waited + 0.5) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { settle(0.5) }
        }
    }

    @objc func wifi(_ call: CAPPluginCall) {
        call.resolve(["permission": "unsupported", "connected": false])
    }

    @objc func location(_ call: CAPPluginCall) {
        accessToken { token in
            guard let token = token else { return call.reject("Sign in to register this phone first.", "presence") }
            self.gateway("companion/presence", nil, bearer: token) { status, json in
                guard status == 200, json["enabled"] as? Bool == true else { return call.reject("Turn on office check-in helpers in Settings → Devices → This phone first.", "consent") }
                self.readLocation(call)
            }
        }
    }

    private func readLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.locationCall == nil else { return call.reject("An office location check is already running.", "busy") }
            let manager = CLLocationManager()
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
            self.locator = manager
            self.locationCall = call
            let timeout = DispatchWorkItem { [weak self] in
                guard let self = self, let pending = self.locationCall else { return }
                self.finishLocation()
                pending.reject("Pulse could not read your position. Try again by a window.", "unavailable")
            }
            self.locationTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
            let state = manager.authorizationStatus
            if state == .notDetermined {
                manager.requestWhenInUseAuthorization()
            } else if state == .authorizedWhenInUse || state == .authorizedAlways {
                manager.requestLocation()
            } else {
                self.finishLocation()
                call.reject("Location permission is off for Pulse.", "permission")
            }
        }
    }

    private func finishLocation() {
        locationTimeout?.cancel()
        locationTimeout = nil
        locator?.stopUpdatingLocation()
        locator?.delegate = nil
        locator = nil
        locationCall = nil
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager === regions { if manager.authorizationStatus == .authorizedAlways { monitorOffices() }; return }
        guard locationCall != nil else { return }
        let state = manager.authorizationStatus
        if state == .authorizedWhenInUse || state == .authorizedAlways { manager.requestLocation() }
        else if state != .notDetermined { locationCall?.reject("Location permission is off for Pulse.", "permission"); finishLocation() }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let call = locationCall, let l = locations.last else { return }
        finishLocation()
        call.resolve(["lat": l.coordinate.latitude, "lng": l.coordinate.longitude, "accuracy": l.horizontalAccuracy, "at": Int(l.timestamp.timeIntervalSince1970 * 1000)])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        locationCall?.reject("Pulse could not read your position. Try again by a window.", "unavailable")
        finishLocation()
    }

    /// iPhone apps update through TestFlight or the App Store, never by downloading an app file.
    @objc func checkUpdate(_ call: CAPPluginCall) { call.resolve(["available": false, "current": version]) }
    @objc func downloadUpdate(_ call: CAPPluginCall) { call.reject("Updates on iPhone come from TestFlight.", "unsupported") }
    @objc func installUpdate(_ call: CAPPluginCall) { call.reject("Updates on iPhone come from TestFlight.", "unsupported") }
    @objc func openInstallSettings(_ call: CAPPluginCall) { call.resolve() }

    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https" else {
            return call.reject("Only https links open outside Pulse.", "scheme")
        }
        DispatchQueue.main.async {
            self.bridge?.viewController?.present(SFSafariViewController(url: url), animated: true)
            call.resolve()
        }
    }

    @objc func saveFile(_ call: CAPPluginCall) {
        let name = (call.getString("name") ?? "Pulse download").replacingOccurrences(of: "/", with: "_")
        guard let data = Data(base64Encoded: call.getString("base64") ?? ""), data.count < 50 * 1024 * 1024 else {
            return call.reject("Pulse could not save the file.", "save")
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do { try data.write(to: file, options: .atomic) } catch { return call.reject("Pulse could not save the file.", "save") }
        DispatchQueue.main.async {
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = self.bridge?.viewController?.view
            self.bridge?.viewController?.present(sheet, animated: true)
            call.resolve()
        }
    }
}
