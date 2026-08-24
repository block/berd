@testable import BerdAirPodsBridge
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

}
