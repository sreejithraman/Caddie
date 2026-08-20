// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CaddieReleaseRuntime",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "CaddieReleaseRuntime", targets: ["CaddieReleaseRuntime"]),
        .executable(name: "CaddieReleaseCrashFixture", targets: ["CaddieReleaseCrashFixture"]),
    ],
    targets: [
        .target(name: "CaddieReleaseRuntime"),
        .executableTarget(name: "CaddieReleaseCrashFixture", dependencies: ["CaddieReleaseRuntime"]),
        .testTarget(
            name: "CaddieReleaseRuntimeTests",
            dependencies: ["CaddieReleaseRuntime", "CaddieReleaseCrashFixture"]
        ),
    ]
)
