// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BerdAirPodsBridge",
    platforms: [.macOS(.v14)],
    products: [
        .library(
            name: "BerdAirPodsBridge",
            type: .static,
            targets: ["BerdAirPodsBridge"]
        )
    ],
    targets: [
        .target(
            name: "BerdAirPodsBridge",
            linkerSettings: [.linkedFramework("AVFAudio")]
        )
    ]
)
