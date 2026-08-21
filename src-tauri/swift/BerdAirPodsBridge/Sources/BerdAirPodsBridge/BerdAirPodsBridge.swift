import AVFoundation
import Foundation

public typealias InputMuteCallback = @convention(c) (Bool) -> Void
public typealias AudioInputCallback = @convention(c) (UnsafePointer<Float>, Int) -> Void

@available(macOS 14.0, *)
private final class AirPodsMuteBridge: @unchecked Sendable {
    private let engine: AVAudioEngine
    private let inputNode: AVAudioInputNode
    private let callback: InputMuteCallback
    private let audioCallback: AudioInputCallback
    private var inputMuteObserver: NSObjectProtocol?

    init(
        callback: @escaping InputMuteCallback,
        audioCallback: @escaping AudioInputCallback
    ) throws {
        self.callback = callback
        self.audioCallback = audioCallback

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw BridgeError.noInputFormat
        }
        self.engine = engine
        self.inputNode = inputNode

        inputNode.installTap(
            onBus: 0,
            bufferSize: 4096,
            format: inputFormat
        ) { [weak self] buffer, _ in
            guard
                let self,
                let channel = buffer.floatChannelData?.pointee,
                buffer.frameLength > 0
            else { return }
            self.audioCallback(channel, Int(buffer.frameLength))
        }
        engine.prepare()
        try engine.start()

        // Match voice-conversation-cli exactly: seed before registration and
        // ignore the expected error when no prior process handler exists.
        try? AVAudioApplication.shared.setInputMuted(false)
        try AVAudioApplication.shared.setInputMuteStateChangeHandler { [weak self] muted in
            self?.callback(muted)
            return true
        }
        inputMuteObserver = NotificationCenter.default.addObserver(
            forName: AVAudioApplication.inputMuteStateChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.callback(AVAudioApplication.shared.isInputMuted)
        }
    }

    func stop() {
        // Reset while the handler exists, then cancel the process-wide callback.
        try? AVAudioApplication.shared.setInputMuted(false)
        try? AVAudioApplication.shared.setInputMuteStateChangeHandler(nil)
        if let inputMuteObserver {
            NotificationCenter.default.removeObserver(inputMuteObserver)
            self.inputMuteObserver = nil
        }
        inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private enum BridgeError: Error {
        case noInputFormat
    }
}

@available(macOS 14.0, *)
private var activeBridge: AirPodsMuteBridge?

@_cdecl("berd_airpods_mute_start")
public func berdAirPodsMuteStart(
    callback: @escaping InputMuteCallback,
    audioCallback: @escaping AudioInputCallback
) -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    do {
        activeBridge?.stop()
        activeBridge = try AirPodsMuteBridge(
            callback: callback,
            audioCallback: audioCallback
        )
        return true
    } catch {
        FileHandle.standardError.write(
            Data("Berd AirPods mute bridge failed to start: \(error)\n".utf8)
        )
        activeBridge = nil
        return false
    }
}

@_cdecl("berd_airpods_mute_stop")
public func berdAirPodsMuteStop() -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    activeBridge?.stop()
    activeBridge = nil
    return true
}

@_cdecl("berd_airpods_mute_set_muted")
public func berdAirPodsMuteSetMuted(_ muted: Bool) -> Bool {
    guard #available(macOS 14.0, *), activeBridge != nil else { return false }
    do {
        try AVAudioApplication.shared.setInputMuted(muted)
        return true
    } catch {
        return false
    }
}
