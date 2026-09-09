// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BerdMacSpeechBridge",
    platforms: [.macOS(.v14)],
    products: [
        .library(
            name: "BerdMacSpeechBridge",
            type: .static,
            targets: ["BerdMacSpeechBridge"]
        )
    ],
    targets: [
        .target(
            name: "BerdMacSpeechBridge",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("Speech"),
            ]
        )
    ]
)
