// Runner receipt: recognize the actual simulator screen, fail on startup errors or the wrong attendance state.
import Foundation
import Vision
import AppKit
let args = CommandLine.arguments
if args.count != 3 { fatalError("Usage: ios-screen-check screenshot.png expected-text") }
if args[2] == "--pip-island" {
    guard let data=try? Data(contentsOf:URL(fileURLWithPath:args[1])),
          let bitmap=NSBitmapImageRep(data:data) else {fatalError("Screenshot could not be decoded")}
    var mint=0, purple=0
    // Restrict to the compact-leading Island: wallpaper, text and the home-screen app icon cannot pass.
    for y in Int(Double(bitmap.pixelsHigh)*0.02)..<Int(Double(bitmap.pixelsHigh)*0.075) {
        for x in Int(Double(bitmap.pixelsWide)*0.09)..<Int(Double(bitmap.pixelsWide)*0.23) {
            guard let color=bitmap.colorAt(x:x,y:y)?.usingColorSpace(.deviceRGB) else {continue}
            let r=color.redComponent,g=color.greenComponent,b=color.blueComponent
            if g>0.6 && b>0.45 && g>r*1.2 && b>r*1.2 {mint += 1}
            if r>0.35 && b>0.55 && g<0.55 && b>r*1.1 {purple += 1}
        }
    }
    guard mint>5 && purple>5 else {fatalError("Pip is missing or a gray placeholder in the Dynamic Island")}
    print("Native Pip colors verified: mint=\(mint), purple=\(purple)")
    exit(0)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: URL(fileURLWithPath: args[1])).perform([request])
let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
try text.write(toFile: args[1] + ".txt", atomically: true, encoding: .utf8)
let normalized = text.lowercased()
if normalized.contains("keychainexception") || normalized.contains("functioncallexception") || normalized.contains("entitlement isn't") {
    fatalError("Pulse startup error is visible in the screenshot")
}
if !normalized.contains(args[2].lowercased()) { fatalError("Expected screen text is missing: " + args[2]) }
