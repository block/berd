import AppKit
import Foundation

@_silgen_name("bbInstallSymlinkWithAuthorization")
private func bbInstallSymlinkWithAuthorization(_ cliPath: UnsafePointer<CChar>) -> Int32

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var installMenuItem: NSMenuItem!
    private var updateNoticeMenuItem: NSMenuItem!
    private var restartUpdateMenuItem: NSMenuItem!
    private let cliStatus = NSTextField(labelWithString: "")
    private let cliDetail = NSTextField(labelWithString: "")
    private let versionStatus = NSTextField(labelWithString: "")
    private let updateStatus = NSTextField(labelWithString: "Updates are not configured in this local build.")
    private let diagnosticsStatus = NSTextField(labelWithString: "")
    private let installButton = NSButton(title: "Repair CLI", target: nil, action: nil)
    private let updateButton = NSButton(title: "Check for Updates", target: nil, action: nil)
    private let diagnosticsButton = NSButton(title: "Copy Diagnostics", target: nil, action: nil)

    private let cliPath = "/usr/local/bin/bb"
    private var automaticInstallAttempted = false
    private var pendingAutomaticInstall = false
    private var isInstallingCLI = false
    private var hasUpdateAvailable = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        buildStatusItem()
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshStatus(installIfNeeded: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow()
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        runPendingAutomaticInstallIfNeeded()
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu(title: "BuilderBot")
        appMenuItem.submenu = appMenu
        appMenu.addItem(menuItem("About BuilderBot", #selector(showAbout), ""))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("Settings...", #selector(openWindow), ","))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("Hide BuilderBot", #selector(hideApp), "h"))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("Quit BuilderBot", #selector(quit), "q"))
        NSApp.mainMenu = mainMenu
    }

    private func buildStatusItem() {
        let menu = NSMenu()
        menu.addItem(menuItem("Open BuilderBot", #selector(openWindow), ""))
        menu.addItem(menuItem("Settings...", #selector(openWindow), ","))
        menu.addItem(.separator())

        updateNoticeMenuItem = menuItem("An update is available", nil, "")
        updateNoticeMenuItem.isEnabled = false
        updateNoticeMenuItem.isHidden = true
        menu.addItem(updateNoticeMenuItem)

        restartUpdateMenuItem = menuItem("Restart to update", #selector(restartToUpdate), "")
        restartUpdateMenuItem.isHidden = true
        menu.addItem(restartUpdateMenuItem)

        installMenuItem = menuItem("Repair CLI", #selector(installOrRepairCLI), "")
        menu.addItem(installMenuItem)
        menu.addItem(.separator())
        menu.addItem(menuItem("Copy Diagnostics", #selector(copyDiagnostics), ""))
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit BuilderBot", #selector(quit), "q"))

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = "BuilderBot"
        statusItem.menu = menu
        updateStatusIcon()
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 360),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "BuilderBot"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.isRestorable = false

        let background = NSVisualEffectView()
        background.material = .windowBackground
        background.blendingMode = .behindWindow
        background.state = .active
        background.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = background

        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .width
        root.distribution = .gravityAreas
        root.spacing = 16
        root.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        root.translatesAutoresizingMaskIntoConstraints = false
        root.setContentHuggingPriority(.required, for: .vertical)
        background.addSubview(root)

        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            root.topAnchor.constraint(equalTo: background.topAnchor),
            root.bottomAnchor.constraint(lessThanOrEqualTo: background.bottomAnchor),
        ])

        root.addArrangedSubview(headerView())

        configureStatusLabel(cliStatus, size: 14, weight: .medium, color: .labelColor)
        configureStatusLabel(cliDetail, size: 12, weight: .regular, color: .secondaryLabelColor)
        configureStatusLabel(versionStatus, size: 12, weight: .regular, color: .secondaryLabelColor)
        configureStatusLabel(updateStatus, size: 12, weight: .regular, color: .secondaryLabelColor)
        configureStatusLabel(diagnosticsStatus, size: 12, weight: .regular, color: .secondaryLabelColor)

        let cliCard = cardView(
            icon: "terminal",
            title: "Command line tool",
            views: [cliStatus, versionStatus, cliDetail],
            action: installButton,
            minHeight: 104
        )
        installButton.target = self
        installButton.action = #selector(installOrRepairCLI)
        styleButton(installButton, prominent: true)
        root.addArrangedSubview(cliCard)

        updateButton.target = self
        updateButton.action = #selector(checkForUpdates)
        styleButton(updateButton, prominent: false)
        root.addArrangedSubview(cardView(icon: "arrow.down.circle", title: "Updates", views: [updateStatus], action: updateButton, minHeight: 74))

        diagnosticsButton.target = self
        diagnosticsButton.action = #selector(copyDiagnostics)
        styleButton(diagnosticsButton, prominent: false)
        root.addArrangedSubview(cardView(icon: "doc.on.clipboard", title: "Diagnostics", views: [diagnosticsStatus], action: diagnosticsButton, minHeight: 74))
    }

    @objc private func openWindow() {
        refreshStatus(installIfNeeded: false)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func checkForUpdates() {
        updateStatus.stringValue = "Updates are not configured in this local build."
        setUpdateAvailable(false)
    }

    @objc private func restartToUpdate() {
        updateStatus.stringValue = "No downloaded update is ready to install."
    }

    @objc private func copyDiagnostics() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(diagnostics(), forType: .string)
        diagnosticsStatus.stringValue = "Diagnostics copied"
    }

    @objc private func installOrRepairCLI() {
        installCLI(showFailureAlert: true)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func hideApp() {
        NSApp.hide(nil)
    }

    private func installCLI(showFailureAlert: Bool) {
        guard !isInstallingCLI else { return }
        let target = bundledCLIPath()
        let fm = FileManager.default

        guard fm.isExecutableFile(atPath: target) else {
            let message = "The app bundle does not contain an executable bb CLI at:\n\n\(target)"
            if showFailureAlert {
                showAlert(title: "Bundled CLI is missing", message: message)
            } else {
                cliStatus.stringValue = "Bundled CLI is missing"
                cliDetail.stringValue = target
            }
            refreshStatus(installIfNeeded: false)
            return
        }

        isInstallingCLI = true
        installButton.isEnabled = false
        installMenuItem.isEnabled = false
        cliStatus.stringValue = "Installing CLI..."
        cliDetail.stringValue = "macOS may ask for permission to update \(cliPath)."
        runAuthorizedCLIInstall(target: target, showFailureAlert: showFailureAlert)
    }

    private func refreshStatus(installIfNeeded: Bool) {
        let target = bundledCLIPath()
        cliStatus.stringValue = "Checking CLI install..."
        cliDetail.stringValue = ""
        installButton.isEnabled = false
        versionStatus.stringValue = "Bundled CLI: checking..."
        diagnosticsStatus.stringValue = ""

        DispatchQueue.global(qos: .userInitiated).async {
            let pathState = self.currentCLIState(expectedTarget: target)
            let version = self.bundledCLIVersion(path: target)

            DispatchQueue.main.async {
                self.cliStatus.stringValue = pathState.message
                self.cliDetail.stringValue = pathState.detail
                self.installButton.title = pathState.buttonTitle
                self.installButton.isEnabled = pathState.canInstall && !self.isInstallingCLI
                self.versionStatus.stringValue = "Bundled CLI: \(version)"
                self.updateStatusItemInstallTitle(pathState.buttonTitle, enabled: pathState.canInstall && !self.isInstallingCLI)

                if installIfNeeded && pathState.shouldAutoInstall && !self.automaticInstallAttempted {
                    self.scheduleAutomaticInstall()
                }
            }
        }
    }

    private func scheduleAutomaticInstall() {
        guard !automaticInstallAttempted else { return }
        automaticInstallAttempted = true
        pendingAutomaticInstall = true
        runPendingAutomaticInstallIfNeeded()
    }

    private func runPendingAutomaticInstallIfNeeded() {
        guard pendingAutomaticInstall, !isInstallingCLI else { return }
        guard NSApp.isActive, window.isVisible, window.isKeyWindow else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.runPendingAutomaticInstallIfNeeded()
            }
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            guard !self.isInstallingCLI else { return }
            guard self.pendingAutomaticInstall else { return }
            guard NSApp.isActive, self.window.isVisible, self.window.isKeyWindow else {
                self.runPendingAutomaticInstallIfNeeded()
                return
            }

            self.pendingAutomaticInstall = false
            self.installCLI(showFailureAlert: false)
        }
    }

    private func bundledCLIPath() -> String {
        return Bundle.main.resourcePath.map { "\($0)/bb" } ?? ""
    }

    private func bundledCLIVersion(path: String) -> String {
        guard FileManager.default.isExecutableFile(atPath: path) else {
            return "missing at \(path)"
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--version"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            guard waitForProcess(process, timeout: 3) else {
                return "timed out reading version"
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"
        } catch {
            return "error reading version: \(error.localizedDescription)"
        }
    }

    private struct CLIState {
        let message: String
        let detail: String
        let buttonTitle: String
        let canInstall: Bool
        let shouldAutoInstall: Bool
    }

    private func currentCLIState(expectedTarget: String) -> CLIState {
        let fm = FileManager.default
        if let destination = try? fm.destinationOfSymbolicLink(atPath: cliPath) {
            let resolvedDestination = resolve(path: destination)
            if resolvedDestination == expectedTarget {
                return CLIState(
                    message: "CLI installed",
                detail: "Path: \(cliPath) -> app bundle CLI",
                buttonTitle: "Repair CLI",
                canInstall: true,
                shouldAutoInstall: false
                )
            }
            return CLIState(
                message: "CLI symlink needs repair",
                detail: "Current path: \(resolvedDestination)",
                buttonTitle: "Repair CLI",
                canInstall: true,
                shouldAutoInstall: true
            )
        }

        if fm.fileExists(atPath: cliPath) {
            return CLIState(
                message: "CLI needs replacement",
                detail: "Path: \(cliPath)",
                buttonTitle: "Replace CLI",
                canInstall: true,
                shouldAutoInstall: true
            )
        }

        if let path = shellOutput("/usr/bin/which", ["bb"]), !path.isEmpty {
            return CLIState(
                message: "CLI found on PATH",
                detail: "Found: \(path)",
                buttonTitle: "Install CLI",
                canInstall: true,
                shouldAutoInstall: true
            )
        }

        return CLIState(
            message: "CLI not installed",
            detail: "Path: \(cliPath)",
            buttonTitle: "Install CLI",
            canInstall: true,
            shouldAutoInstall: true
        )
    }

    private func resolve(path: String) -> String {
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    private func shellOutput(_ executable: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            guard waitForProcess(process, timeout: 3) else {
                return nil
            }
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func diagnostics() -> String {
        let target = bundledCLIPath()
        return """
        app_version=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown")
        bundle_path=\(Bundle.main.bundlePath)
        bundled_cli=\(target)
        bundled_cli_version=\(bundledCLIVersion(path: target))
        path_bb=\(shellOutput("/usr/bin/which", ["bb"]) ?? "not found")
        usr_local_bb=\((try? FileManager.default.destinationOfSymbolicLink(atPath: cliPath)) ?? "not a symlink")
        update_status=\(updateStatus.stringValue)
        """
    }

    private func updateStatusItemInstallTitle(_ title: String, enabled: Bool) {
        installMenuItem.title = title
        installMenuItem.isEnabled = enabled
    }

    private func runAuthorizedCLIInstall(target: String, showFailureAlert: Bool) {
        DispatchQueue.global(qos: .userInitiated).async {
            let status = target.withCString { cliPath in
                bbInstallSymlinkWithAuthorization(cliPath)
            }

            DispatchQueue.main.async {
                self.isInstallingCLI = false
                if status == 0 {
                    self.diagnosticsStatus.stringValue = "CLI installed"
                    self.cliStatus.stringValue = "CLI installed"
                    self.cliDetail.stringValue = "Path: \(self.cliPath) -> app bundle CLI"
                } else if status == -11 {
                    self.cliStatus.stringValue = "CLI install cancelled"
                    self.cliDetail.stringValue = "BuilderBot did not update \(self.cliPath)."
                    if showFailureAlert {
                        self.showAlert(title: "CLI install was cancelled", message: "BuilderBot did not install the bb command line tool.")
                    }
                } else {
                    self.cliStatus.stringValue = "CLI install failed"
                    self.cliDetail.stringValue = "BuilderBot could not install \(self.cliPath). Error code: \(status)."
                    if showFailureAlert {
                        self.showAlert(
                            title: "CLI install failed",
                            message: "BuilderBot could not install /usr/local/bin/bb. Error code: \(status)"
                        )
                    }
                }
                self.refreshStatus(installIfNeeded: false)
            }
        }
    }

    private func waitForProcess(_ process: Process, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            return false
        }
        return true
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func menuItem(_ title: String, _ action: Selector?, _ keyEquivalent: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = self
        return item
    }

    private func headerView() -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 14

        let imageView = NSImageView()
        imageView.image = NSApp.applicationIconImage
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalToConstant: 56),
            imageView.heightAnchor.constraint(equalToConstant: 56),
        ])
        row.addArrangedSubview(imageView)

        let text = NSStackView()
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 3

        let title = NSTextField(labelWithString: "BuilderBot")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        title.textColor = .labelColor

        let subtitle = NSTextField(labelWithString: "bb command line tool")
        subtitle.font = .systemFont(ofSize: 13, weight: .regular)
        subtitle.textColor = .secondaryLabelColor

        text.addArrangedSubview(title)
        text.addArrangedSubview(subtitle)
        row.addArrangedSubview(text)
        return row
    }

    private func cardView(icon: String, title: String, views: [NSView], action: NSButton, minHeight: CGFloat) -> NSView {
        let card = NSView()
        card.translatesAutoresizingMaskIntoConstraints = false
        card.wantsLayer = true
        card.layer?.cornerRadius = 12
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.45).cgColor
        card.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.72).cgColor
        card.setContentHuggingPriority(.required, for: .vertical)
        card.setContentCompressionResistancePriority(.required, for: .vertical)

        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.distribution = .fill
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false

        let iconView = NSImageView()
        iconView.image = NSImage(systemSymbolName: icon, accessibilityDescription: title)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 18, weight: .medium)
        iconView.contentTintColor = .labelColor
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 24),
            iconView.heightAnchor.constraint(equalToConstant: 24),
        ])
        row.addArrangedSubview(iconView)

        let text = NSStackView()
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 4
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .labelColor
        text.addArrangedSubview(titleLabel)
        views.forEach { text.addArrangedSubview($0) }
        row.addArrangedSubview(text)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        row.addArrangedSubview(spacer)
        row.addArrangedSubview(action)

        card.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
            card.heightAnchor.constraint(greaterThanOrEqualToConstant: minHeight),
        ])

        return card
    }

    private func configureStatusLabel(_ label: NSTextField, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.lineBreakMode = .byTruncatingMiddle
        label.maximumNumberOfLines = 1
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    private func styleButton(_ button: NSButton, prominent: Bool) {
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.font = .systemFont(ofSize: 13, weight: .medium)
        button.setContentHuggingPriority(.required, for: .horizontal)
        if prominent {
            button.bezelColor = NSColor.controlAccentColor
        }
    }

    private func setUpdateAvailable(_ available: Bool) {
        hasUpdateAvailable = available
        updateNoticeMenuItem.isHidden = !available
        restartUpdateMenuItem.isHidden = !available
        updateStatusIcon()
    }

    private func updateStatusIcon() {
        let imageName = hasUpdateAvailable ? "bbStatusUpdate" : "bbStatus"
        if let image = NSImage(named: imageName) {
            image.isTemplate = true
            statusItem.button?.image = image
            statusItem.button?.title = ""
            return
        }
        statusItem.button?.image = nil
        statusItem.button?.title = hasUpdateAvailable ? "bb!" : "bb"
    }
}

@main
enum BuilderBotApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
