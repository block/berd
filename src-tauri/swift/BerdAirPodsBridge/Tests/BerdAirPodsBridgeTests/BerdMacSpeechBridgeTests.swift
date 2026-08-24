@testable import BerdAirPodsBridge
import Speech
import XCTest

final class BerdMacSpeechBridgeTests: XCTestCase {
    func testSpeechAuthorizationLifecycleStates() {
        XCTAssertEqual(
            speechAuthorizationDisposition(for: .authorized),
            .proceed
        )
        XCTAssertEqual(
            speechAuthorizationDisposition(for: .notDetermined),
            .request
        )
        XCTAssertEqual(
            speechAuthorizationDisposition(for: .denied),
            .denied
        )
        XCTAssertEqual(
            speechAuthorizationDisposition(for: .restricted),
            .restricted
        )
    }

    @available(macOS 26.0, *)
    func testCompatibleInstalledFormatWinsOverLaggingInventory() {
        let readiness = resolveModelReadiness(
            compatibleInstalledFormatAvailable: true,
            inventory: .supported
        )

        XCTAssertTrue(readiness.ready)
        XCTAssertEqual(readiness.status, "installed")
    }

    @available(macOS 26.0, *)
    func testMissingCompatibleFormatPreservesInventoryState() {
        let readiness = resolveModelReadiness(
            compatibleInstalledFormatAvailable: false,
            inventory: .downloading
        )

        XCTAssertFalse(readiness.ready)
        XCTAssertEqual(readiness.status, "downloading")
    }

}
