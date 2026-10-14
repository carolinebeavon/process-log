// ProcessLogMenu.swift — a button for the Mac's top menu bar, and a quiet corner reminder.
//
//   click        = capture now (the same as the big button on the page)
//   next to it   = the time left until the next automatic capture (can be switched off in the menu)
//   right-click  = a small menu: pause / resume, open the page, quit
//   corner panel = after a capture, a small panel stays in a corner of the
//                  main screen until you caption it or delete it. It hides itself while
//                  a capture is being recorded, so it never ends up in your own clip.
//
// It does not record anything itself. It only tells the Process Log server
// (http://localhost:3002) what to do and shows what the server says is happening.
// If the server is not running, clicking the icon starts it.

import AppKit

// The address of the Process Log server. (PROCESS_LOG_PORT is only for testing against a stand-in server.)
let serverURL = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["PROCESS_LOG_PORT"] ?? "3002")")!

// The part of the server's answer this button cares about.
struct ServerState: Decodable {
    let logging: Bool
    let capturing: Bool
    let phase: String?
    let captureKind: String?      // "auto" or "button" while recording
    let captureStartedAt: Double? // milliseconds
    let nextAt: Double?           // milliseconds
    let seconds: Double
    let warmupSeconds: Double
    let error: ErrorInfo?
    let captures: [CaptureInfo]   // newest first
    struct ErrorInfo: Decodable { let message: String }
    struct CaptureInfo: Decodable {
        let id: String
        let time: String
        let pending: Bool?        // true: an automatic capture still waiting for a caption
    }
}

// The small panel that waits in a corner. It never takes the keyboard focus.
final class ReminderPanel {
    private let panel: NSPanel
    private let picture = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private var shownId: String?
    var onCaption: ((String) -> Void)?
    var onDelete: ((String) -> Void)?
    private let deleteButton = NSButton(title: "Delete", target: nil, action: nil)
    private var deleteArmed = false
    private var disarmTimer: Timer?

    init() {
        let size = NSSize(width: 300, height: 92)
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.alphaValue = 0.94
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        let background = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 12
        background.layer?.masksToBounds = true
        panel.contentView = background

        picture.frame = NSRect(x: 10, y: 10, width: 46, height: 72)
        picture.imageScaling = .scaleProportionallyUpOrDown
        title.frame = NSRect(x: 66, y: 62, width: 224, height: 18)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        detail.frame = NSRect(x: 66, y: 44, width: 224, height: 16)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor

        let caption = NSButton(title: "Caption", target: self, action: #selector(captionClicked))
        caption.frame = NSRect(x: 66, y: 10, width: 82, height: 26)
        deleteButton.target = self
        deleteButton.action = #selector(deleteClicked)
        deleteButton.frame = NSRect(x: 154, y: 10, width: 110, height: 26)
        for button in [caption, deleteButton] { button.bezelStyle = .rounded; button.controlSize = .small }

        for view in [picture, title, detail, caption, deleteButton] { background.addSubview(view) }
    }

    // Shows the newest waiting capture, and how many are waiting in all.
    func show(id: String, time: String, count: Int) {
        title.stringValue = "New capture · \(ReminderPanel.clock(time))"
        detail.stringValue = count > 1 ? "\(count) are waiting for a caption" : "Waiting for a caption"
        if id != shownId {
            shownId = id
            disarmDelete()
            picture.image = nil
            let url = serverURL.appendingPathComponent("files/\(id)/poster.jpg")
            DispatchQueue.global().async {
                let image = NSImage(contentsOf: url)
                DispatchQueue.main.async { if self.shownId == id { self.picture.image = image } }
            }
        }
        if !panel.isVisible {
            // Bottom-right corner of the main screen (the one with the menu bar), above the Dock.
            if let area = NSScreen.screens.first?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: area.maxX - panel.frame.width - 16, y: area.minY + 16))
            }
            panel.orderFrontRegardless()
        }
    }

    func hide() {
        if panel.isVisible { panel.orderOut(nil) }
    }

    static func clock(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return "" }
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: date)
    }

    @objc func captionClicked() { if let id = shownId { onCaption?(id) } }
    // Delete removes the capture and its videos for good, so it asks twice: the first click arms it for
    // three seconds ("Sure? Delete"), the second click does it.
    @objc func deleteClicked() {
        guard let id = shownId else { return }
        if deleteArmed { disarmDelete(); onDelete?(id); return }
        deleteArmed = true
        deleteButton.title = "Sure? Delete"
        disarmTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.disarmDelete() }
    }

    private func disarmDelete() {
        disarmTimer?.invalidate()
        deleteArmed = false
        deleteButton.title = "Delete"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var state: ServerState?
    var serverReachable = false
    var timer: Timer?
    let reminder = ReminderPanel()

    // Whether the countdown shows beside the icon. Remembered between runs; on unless switched off.
    var showCountdown: Bool {
        get { UserDefaults.standard.object(forKey: "showCountdown") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "showCountdown"); draw() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // no Dock icon
        if let button = statusItem.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular) // digits keep one width, so the countdown does not jitter
            button.target = self
            button.action = #selector(iconClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        reminder.onCaption = { id in NSWorkspace.shared.open(URL(string: "http://localhost:3002/#\(id)")!) }
        reminder.onDelete = { [weak self] id in
            self?.request("DELETE", "api/captures/\(id)") { self?.poll() }
        }
        draw()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    // ---------------------------------------------------------- talking to the server

    func request(_ method: String, _ path: String, body: [String: Any]? = nil, done: (() -> Void)? = nil) {
        var req = URLRequest(url: serverURL.appendingPathComponent(path))
        req.httpMethod = method
        req.timeoutInterval = 3
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { _, _, _ in
            DispatchQueue.main.async { done?() }
        }.resume()
    }

    func poll() {
        var req = URLRequest(url: serverURL.appendingPathComponent("api/state"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let decoded = data.flatMap { try? JSONDecoder().decode(ServerState.self, from: $0) }
            DispatchQueue.main.async {
                self?.serverReachable = decoded != nil
                self?.state = decoded
                self?.draw()
            }
        }.resume()
    }

    // ---------------------------------------------------------- what the icon shows

    func secondsLeft() -> Int {
        guard let s = state, let started = s.captureStartedAt else { return 0 }
        let elapsed = Date().timeIntervalSince1970 - started / 1000
        return max(0, Int((s.seconds + s.warmupSeconds - elapsed).rounded(.up)))
    }

    func countdownText() -> String {
        guard let next = state?.nextAt else { return "" }
        let left = max(0, Int(next / 1000 - Date().timeIntervalSince1970))
        return String(format: "%d:%02d", left / 60, left % 60)
    }

    func draw() {
        guard let button = statusItem.button else { return }
        var symbol = "camera.viewfinder"
        var title = ""
        var tint: NSColor? = nil
        var tip = "Click to capture now. Right-click for the menu."

        if !serverReachable {
            symbol = "exclamationmark.triangle"
            tip = "The Process Log is not running. Click to start it."
        } else if let s = state, s.capturing, s.captureKind == "button" {
            // Only a capture you asked for shows a red countdown. An automatic one stays quiet.
            symbol = "record.circle.fill"
            tint = .systemRed
            let left = secondsLeft()
            title = s.phase == "recording" && left > 0 ? " \(left)" : " …"
        } else if let s = state, s.error != nil {
            symbol = "exclamationmark.circle.fill"
            tint = .systemOrange
            tip = "The last capture failed. Open the page to see why."
        } else if let s = state, !s.logging {
            symbol = "pause.circle"
            tip = "Logging is paused. Click to capture now."
        }

        // The time to the next automatic capture, beside the icon, while logging is on and nothing is recording.
        // (An automatic capture stays quiet: no red icon, no countdown of its own.)
        if showCountdown, serverReachable, let s = state, s.logging, !s.capturing, title.isEmpty {
            title = " \(countdownText())"
            tip = "Next automatic capture in \(countdownText()). Click to capture now. Right-click for the menu."
        }

        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Process Log")
        button.contentTintColor = tint
        button.title = title
        button.toolTip = tip
        syncReminder()
    }

    // The corner panel: shown while an automatic capture waits for a caption, never during a recording.
    func syncReminder() {
        let waiting = (state?.captures ?? []).filter { $0.pending == true }
        if !serverReachable || state?.capturing == true || waiting.isEmpty {
            reminder.hide()
        } else {
            reminder.show(id: waiting[0].id, time: waiting[0].time, count: waiting.count)
        }
    }

    // ---------------------------------------------------------- clicks

    @objc func iconClicked() {
        let flags = NSApp.currentEvent?.modifierFlags ?? []
        let wantsMenu = NSApp.currentEvent?.type == .rightMouseUp || flags.contains(.control) || flags.contains(.option)
        if wantsMenu { showMenu() } else { captureNow() }
    }

    func captureNow() {
        if !serverReachable { startServer(); return }
        if state?.capturing == true { return } // already recording
        request("POST", "api/capture") { [weak self] in self?.poll() }
    }

    func startServer() {
        let command = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("Start Process Log.command")
        NSWorkspace.shared.open(command)
    }

    func showMenu() {
        let menu = NSMenu()
        let info: String
        if !serverReachable { info = "The Process Log is not running" }
        else if state?.logging == true { info = "Logging is ON, next capture in \(countdownText())" }
        else { info = "Logging is PAUSED" }
        let header = NSMenuItem(title: info, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if serverReachable {
            menu.addItem(item("Capture now", #selector(captureNowFromMenu)))
            menu.addItem(item(state?.logging == true ? "Pause logging" : "Resume logging", #selector(toggleLogging)))
            let countdownItem = item("Show the countdown in the menu bar", #selector(toggleCountdown))
            countdownItem.state = showCountdown ? .on : .off
            menu.addItem(countdownItem)
        } else {
            menu.addItem(item("Start the Process Log", #selector(startServerFromMenu)))
        }
        menu.addItem(item("Open the Process Log page", #selector(openPage)))
        menu.addItem(.separator())
        menu.addItem(item("Remove this button from the menu bar", #selector(quit)))

        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil // so the next plain click captures instead of opening the menu
    }

    func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
        menuItem.target = self
        return menuItem
    }

    @objc func captureNowFromMenu() { captureNow() }
    @objc func startServerFromMenu() { startServer() }
    @objc func toggleCountdown() { showCountdown.toggle() }
    @objc func toggleLogging() {
        request("POST", "api/logging", body: ["on": !(state?.logging ?? true)]) { [weak self] in self?.poll() }
    }
    @objc func openPage() { NSWorkspace.shared.open(serverURL) }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
