import AVFAudio
import BerdObjCExceptionCatch
import Foundation

private let bridgeQueue = DispatchQueue(label: "com.berd.airpods-capture")

@available(macOS 14.0, *)
private final class AirPodsCapture: @unchecked Sendable {
    private var engine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var configurationObserver: NSObjectProtocol?
    private var inputMuteObserver: NSObjectProtocol?
    private var restart: DispatchWorkItem?
    private var generation: UInt64 = 0
    private var stopped = false

    init() throws {
        try startEngine()
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        generation &+= 1
        restart?.cancel()
        restart = nil
        tearDownEngine()
    }

    private func startEngine() throws {
        let engine = AVAudioEngine()
        var caughtInputNode: AVAudioInputNode?
        var inputNodeError: NSError?
        BerdTryObjCBlock({ caughtInputNode = engine.inputNode }, &inputNodeError)
        guard inputNodeError == nil, let inputNode = caughtInputNode else {
            throw CaptureError.objectiveC(inputNodeError?.localizedDescription ?? "no input node")
        }

        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.noInputFormat
        }
        var tapError: NSError?
        BerdTryObjCBlock({
            inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in }
        }, &tapError)
        guard tapError == nil else {
            throw CaptureError.objectiveC(tapError?.localizedDescription ?? "install tap failed")
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            removeTap(from: inputNode)
            throw error
        }
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.scheduleRestart()
        }
        inputMuteObserver = NotificationCenter.default.addObserver(
            forName: AVAudioApplication.inputMuteStateChangeNotification,
            object: nil,
            queue: nil
        ) { _ in
            _ = AVAudioApplication.shared.isInputMuted
        }
        self.engine = engine
        self.inputNode = inputNode
    }

    private func tearDownEngine() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let inputMuteObserver {
            NotificationCenter.default.removeObserver(inputMuteObserver)
            self.inputMuteObserver = nil
        }
        if let inputNode { removeTap(from: inputNode) }
        engine?.stop()
        inputNode = nil
        engine = nil
    }

    private func removeTap(from inputNode: AVAudioInputNode) {
        var error: NSError?
        BerdTryObjCBlock({ inputNode.removeTap(onBus: 0) }, &error)
    }

    private func scheduleRestart() {
        bridgeQueue.async { [weak self] in
            guard let self, !stopped else { return }
            generation &+= 1
            let expectedGeneration = generation
            restart?.cancel()
            let work = DispatchWorkItem { [weak self] in
                self?.restartEngine(expectedGeneration)
            }
            restart = work
            bridgeQueue.asyncAfter(deadline: .now() + 0.15, execute: work)
        }
    }

    private func restartEngine(_ expectedGeneration: UInt64) {
        guard !stopped, generation == expectedGeneration else { return }
        restart = nil
        tearDownEngine()
        do {
            try startEngine()
        } catch {
            let work = DispatchWorkItem { [weak self] in
                self?.restartEngine(expectedGeneration)
            }
            restart = work
            bridgeQueue.asyncAfter(deadline: .now() + 1, execute: work)
        }
    }

    private enum CaptureError: Error {
        case noInputFormat
        case objectiveC(String)
    }
}

@available(macOS 14.0, *)
private var activeCapture: AirPodsCapture?

@_cdecl("berd_airpods_capture_start")
public func berdAirPodsCaptureStart() -> Bool {
    guard #available(macOS 14.0, *) else { return false }
    return bridgeQueue.sync {
        do {
            activeCapture?.stop()
            activeCapture = try AirPodsCapture()
            return true
        } catch {
            activeCapture = nil
            return false
        }
    }
}

@_cdecl("berd_airpods_capture_stop")
public func berdAirPodsCaptureStop() {
    guard #available(macOS 14.0, *) else { return }
    bridgeQueue.sync {
        activeCapture?.stop()
        activeCapture = nil
    }
}
