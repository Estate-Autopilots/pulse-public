// Runner receipt: recognize the actual simulator screen, fail on startup errors or the wrong attendance state.
import Foundation
import Vision
let args = CommandLine.arguments
if args.count != 3 { fatalError("Usage: ios-screen-check screenshot.png expected-text") }
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
