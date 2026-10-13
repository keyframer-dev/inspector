#!/usr/bin/env python3
"""Writes KeyframerExample.xcodeproj: an iOS app target and a UI test target, with the package one
directory up as a local Swift package.

The project uses folder-synchronized groups (Xcode 16+, objectVersion 77), so it lists no source
files: anything added to KeyframerExample/ or KeyframerExampleUITests/ is picked up on its own and the
project only changes when settings do. Run it again after editing the settings below:

    python3 Example/generate-project.py
"""
import hashlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(HERE, "KeyframerExample.xcodeproj")
APP = "KeyframerExample"
UITESTS = "KeyframerExampleUITests"
BUNDLE_ID = "dev.keyframer.inspector.example"


def oid(name: str) -> str:
    """Stable 24-hex-digit object ids, so regenerating changes nothing."""
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()


def settings(d: dict) -> str:
    def value(v):
        if isinstance(v, list):
            return "(" + "".join(f'"{x}", ' for x in v) + ")"
        s = str(v)
        return s if s.replace("_", "").replace(".", "").isalnum() and s else f'"{s}"'

    return "".join(f"\t\t\t\t{k} = {value(v)};\n" for k, v in sorted(d.items()))


PROJECT_COMMON = {
    "ALWAYS_SEARCH_USER_PATHS": "NO",
    "CLANG_ENABLE_MODULES": "YES",
    "CLANG_ENABLE_OBJC_ARC": "YES",
    "COPY_PHASE_STRIP": "NO",
    "ENABLE_STRICT_OBJC_MSGSEND": "YES",
    "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
    "GCC_C_LANGUAGE_STANDARD": "gnu17",
    "IPHONEOS_DEPLOYMENT_TARGET": "15.0",
    "LOCALIZATION_PREFERS_STRING_CATALOGS": "YES",
    "SDKROOT": "iphoneos",
    "SWIFT_VERSION": "5.0",
}
PROJECT_DEBUG = {
    **PROJECT_COMMON,
    "DEBUG_INFORMATION_FORMAT": "dwarf",
    "ENABLE_TESTABILITY": "YES",
    "GCC_OPTIMIZATION_LEVEL": "0",
    "GCC_PREPROCESSOR_DEFINITIONS": ["DEBUG=1", "$(inherited)"],
    "ONLY_ACTIVE_ARCH": "YES",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG $(inherited)",
    "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
}
PROJECT_RELEASE = {
    **PROJECT_COMMON,
    "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym",
    "ENABLE_NS_ASSERTIONS": "NO",
    "SWIFT_COMPILATION_MODE": "wholemodule",
    "VALIDATE_PRODUCT": "YES",
}
APP_SETTINGS = {
    "CODE_SIGN_STYLE": "Automatic",
    "CURRENT_PROJECT_VERSION": "1",
    "GENERATE_INFOPLIST_FILE": "YES",
    # Partial Info.plist (ATS for ws:// on the LAN, 120 Hz), merged with the generated keys below.
    "INFOPLIST_FILE": "Info.plist",
    "INFOPLIST_KEY_CFBundleDisplayName": "Keyframer UIKit",
    "INFOPLIST_KEY_NSLocalNetworkUsageDescription": "Connects to the Keyframer inspector on your Mac.",
    "INFOPLIST_KEY_UIApplicationSceneManifest_Generation": "YES",
    "INFOPLIST_KEY_UILaunchScreen_Generation": "YES",
    "INFOPLIST_KEY_UISupportedInterfaceOrientations": "UIInterfaceOrientationPortrait",
    "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
    "MARKETING_VERSION": "1.0",
    "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_ID,
    "PRODUCT_NAME": "$(TARGET_NAME)",
    "SWIFT_EMIT_LOC_STRINGS": "YES",
    "TARGETED_DEVICE_FAMILY": "1",
}
UITEST_SETTINGS = {
    "CODE_SIGN_STYLE": "Automatic",
    "CURRENT_PROJECT_VERSION": "1",
    "GENERATE_INFOPLIST_FILE": "YES",
    # XCTest itself needs iOS 17; the app stays on 15.
    "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
    "MARKETING_VERSION": "1.0",
    "PRODUCT_BUNDLE_IDENTIFIER": f"{BUNDLE_ID}.uitests",
    "PRODUCT_NAME": "$(TARGET_NAME)",
    "SWIFT_EMIT_LOC_STRINGS": "NO",
    "TARGETED_DEVICE_FAMILY": "1",
    "TEST_TARGET_NAME": APP,
}

I = {k: oid(k) for k in [
    "project", "main", "products", "app.ref", "uit.ref", "app.group", "uit.group",
    "app.target", "uit.target", "app.sources", "app.frameworks", "app.resources",
    "uit.sources", "uit.frameworks", "uit.resources", "pkg.ref", "pkg.product", "pkg.build",
    "proxy", "dependency", "cl.project", "cl.app", "cl.uit",
    "project.debug", "project.release", "app.debug", "app.release", "uit.debug", "uit.release",
]}


def config(name: str, key: str, s: dict) -> str:
    return f"\t\t{I[key]} /* {name} */ = {{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {{\n{settings(s)}\t\t\t}};\n\t\t\tname = {name};\n\t\t}};\n"


def config_list(key: str, debug: str, release: str) -> str:
    return (f"\t\t{I[key]} = {{\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t{I[debug]},\n\t\t\t\t{I[release]},\n\t\t\t);\n"
            f"\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Release;\n\t\t}};\n")


def phase(key: str, isa: str, files: str = "") -> str:
    return f"\t\t{I[key]} = {{\n\t\t\tisa = {isa};\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = ({files});\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t}};\n"


pbx = f"""// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 77;
	objects = {{
		{I["pkg.build"]} /* KeyframerInspector in Frameworks */ = {{isa = PBXBuildFile; productRef = {I["pkg.product"]} /* KeyframerInspector */; }};
		{I["proxy"]} = {{isa = PBXContainerItemProxy; containerPortal = {I["project"]}; proxyType = 1; remoteGlobalIDString = {I["app.target"]}; remoteInfo = {APP}; }};
		{I["app.ref"]} = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = {APP}.app; sourceTree = BUILT_PRODUCTS_DIR; }};
		{I["uit.ref"]} = {{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = {UITESTS}.xctest; sourceTree = BUILT_PRODUCTS_DIR; }};
		{I["app.group"]} = {{isa = PBXFileSystemSynchronizedRootGroup; path = {APP}; sourceTree = "<group>"; }};
		{I["uit.group"]} = {{isa = PBXFileSystemSynchronizedRootGroup; path = {UITESTS}; sourceTree = "<group>"; }};
{phase("app.frameworks", "PBXFrameworksBuildPhase", I["pkg.build"] + ",")}{phase("uit.frameworks", "PBXFrameworksBuildPhase")}{phase("app.resources", "PBXResourcesBuildPhase")}{phase("uit.resources", "PBXResourcesBuildPhase")}{phase("app.sources", "PBXSourcesBuildPhase")}{phase("uit.sources", "PBXSourcesBuildPhase")}		{I["main"]} = {{
			isa = PBXGroup;
			children = (
				{I["app.group"]},
				{I["uit.group"]},
				{I["products"]},
			);
			sourceTree = "<group>";
		}};
		{I["products"]} = {{
			isa = PBXGroup;
			children = (
				{I["app.ref"]},
				{I["uit.ref"]},
			);
			name = Products;
			sourceTree = "<group>";
		}};
		{I["app.target"]} /* {APP} */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {I["cl.app"]};
			buildPhases = (
				{I["app.sources"]},
				{I["app.frameworks"]},
				{I["app.resources"]},
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
				{I["app.group"]},
			);
			name = {APP};
			packageProductDependencies = (
				{I["pkg.product"]},
			);
			productName = {APP};
			productReference = {I["app.ref"]};
			productType = "com.apple.product-type.application";
		}};
		{I["uit.target"]} /* {UITESTS} */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {I["cl.uit"]};
			buildPhases = (
				{I["uit.sources"]},
				{I["uit.frameworks"]},
				{I["uit.resources"]},
			);
			buildRules = (
			);
			dependencies = (
				{I["dependency"]},
			);
			fileSystemSynchronizedGroups = (
				{I["uit.group"]},
			);
			name = {UITESTS};
			productName = {UITESTS};
			productReference = {I["uit.ref"]};
			productType = "com.apple.product-type.bundle.ui-testing";
		}};
		{I["project"]} /* Project object */ = {{
			isa = PBXProject;
			attributes = {{
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
				TargetAttributes = {{
					{I["app.target"]} = {{
						CreatedOnToolsVersion = 16.0;
					}};
					{I["uit.target"]} = {{
						CreatedOnToolsVersion = 16.0;
						TestTargetID = {I["app.target"]};
					}};
				}};
			}};
			buildConfigurationList = {I["cl.project"]};
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = {I["main"]};
			minimizedProjectReferenceProxies = 1;
			packageReferences = (
				{I["pkg.ref"]} /* XCLocalSwiftPackageReference ".." */,
			);
			preferredProjectObjectVersion = 77;
			productRefGroup = {I["products"]};
			projectDirPath = "";
			projectRoot = "";
			targets = (
				{I["app.target"]},
				{I["uit.target"]},
			);
		}};
		{I["dependency"]} = {{isa = PBXTargetDependency; target = {I["app.target"]}; targetProxy = {I["proxy"]}; }};
{config("Debug", "project.debug", PROJECT_DEBUG)}{config("Release", "project.release", PROJECT_RELEASE)}{config("Debug", "app.debug", APP_SETTINGS)}{config("Release", "app.release", APP_SETTINGS)}{config("Debug", "uit.debug", UITEST_SETTINGS)}{config("Release", "uit.release", UITEST_SETTINGS)}{config_list("cl.project", "project.debug", "project.release")}{config_list("cl.app", "app.debug", "app.release")}{config_list("cl.uit", "uit.debug", "uit.release")}		{I["pkg.ref"]} /* XCLocalSwiftPackageReference ".." */ = {{
			isa = XCLocalSwiftPackageReference;
			relativePath = ..;
		}};
		{I["pkg.product"]} /* KeyframerInspector */ = {{
			isa = XCSwiftPackageProductDependency;
			productName = KeyframerInspector;
		}};
	}};
	rootObject = {I["project"]} /* Project object */;
}}
"""

scheme = f"""<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{I["app.target"]}" BuildableName = "{APP}.app" BlueprintName = "{APP}" ReferencedContainer = "container:KeyframerExample.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{I["uit.target"]}" BuildableName = "{UITESTS}.xctest" BlueprintName = "{UITESTS}" ReferencedContainer = "container:KeyframerExample.xcodeproj">
            </BuildableReference>
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "{I["app.target"]}" BuildableName = "{APP}.app" BlueprintName = "{APP}" ReferencedContainer = "container:KeyframerExample.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
"""

os.makedirs(os.path.join(PROJECT, "xcshareddata", "xcschemes"), exist_ok=True)
with open(os.path.join(PROJECT, "project.pbxproj"), "w") as f:
    f.write(pbx)
with open(os.path.join(PROJECT, "xcshareddata", "xcschemes", f"{APP}.xcscheme"), "w") as f:
    f.write(scheme)
print(f"wrote {os.path.relpath(PROJECT)}")
