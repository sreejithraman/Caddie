// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CaddieReleaseRuntime",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "CaddieReleaseRuntime", targets: ["CaddieReleaseRuntime"]),
        .library(name: "CaddieMacAppCore", targets: ["CaddieMacAppCore"]),
        .executable(name: "CaddieMenuApp", targets: ["CaddieMenuApp"]),
        .executable(name: "CaddieReleaseCrashFixture", targets: ["CaddieReleaseCrashFixture"]),
    ],
    targets: [
        .target(name: "CaddieReleaseRuntime"),
        .target(
            name: "CaddieMacAppCore",
            dependencies: ["CaddieReleaseRuntime"]
        ),
        .executableTarget(
            name: "CaddieMenuApp",
            dependencies: ["CaddieMacAppCore"]
        ),
        .executableTarget(name: "CaddieReleaseCrashFixture", dependencies: ["CaddieReleaseRuntime"]),
        .testTarget(
            name: "CaddieReleaseRuntimeTests",
            dependencies: ["CaddieReleaseRuntime", "CaddieReleaseCrashFixture"]
        ),
        .testTarget(
            name: "CaddieMacAppCoreTests",
            dependencies: ["CaddieMacAppCore"]
        ),
    ]
)
