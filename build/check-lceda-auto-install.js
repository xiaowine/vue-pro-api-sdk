/**
 * LcEDA Pro extension auto installer (watch mode).
 *
 * CLI arguments:
 * - --browser <msedge|chrome|chromium>
 *   Browser family to use. Default: msedge
 *
 * - --browser-path <path>
 *   Optional executable path for browser. If omitted, script uses common install paths.
 *   Example: --browser-path "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *
 * - --user-data-dir <path>
 *   Browser user profile directory used for CDP session reuse.
 *   Can be relative or absolute. Default: ./build/.browser-<browser>-cdp-profile
 *
 * - --dist-dir <path>
 *   Directory to watch for .eext packages.
 *   Can be relative or absolute. Default: ./build/dist
 *
 * - --cdp-port <number>
 *   Remote debugging port for CDP. Default: 9222
 *
 * - --watch-interval <ms>
 *   Polling interval for artifact change detection. Default: 1200
 *
 * - --install-on-watch-start <0|1>
 *   Whether to install immediately on startup if artifact exists. Default: 1
 *
 * Usage examples:
 * - pnpm run check-install
 * - pnpm run check-install -- --browser chrome
 * - pnpm run check-install -- --browser chromium --dist-dir ./custom-dist
 * - pnpm run check-install -- --browser msedge --user-data-dir ./build/.edge-cdp-profile --cdp-port 9333
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function parseCliArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			continue;
		}

		const body = arg.slice(2);
		const eqIndex = body.indexOf("=");
		let key = body;
		let value = "1";

		if (eqIndex >= 0) {
			key = body.slice(0, eqIndex);
			value = body.slice(eqIndex + 1);
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
			value = argv[i + 1];
			i += 1;
		}

		const camelKey = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
		parsed[camelKey] = value;
	}

	return parsed;
}

function resolveInputPath(inputPath, fallbackPath) {
	const finalPath = inputPath || fallbackPath;
	return path.isAbsolute(finalPath) ? finalPath : path.resolve(process.cwd(), finalPath);
}

function normalizeBrowserName(value) {
	const raw = String(value || "msedge").toLowerCase();
	if (raw === "edge" || raw === "msedge") {
		return "msedge";
	}
	if (raw === "chrome" || raw === "google-chrome") {
		return "chrome";
	}
	if (raw === "chromium") {
		return "chromium";
	}
	throw new Error(`Unsupported browser: ${value}. Use one of: msedge, chrome, chromium.`);
}

const CLI = parseCliArgs(process.argv.slice(2));

// Target editor page.
const TARGET_URL = "https://pro.lceda.cn/editor";
const TARGET_ORIGIN = new URL(TARGET_URL).origin;

// Browser/CDP config.
const BROWSER_NAME = normalizeBrowserName(CLI.browser || process.env.BROWSER || "msedge");
const BROWSER_CDP_PORT = Number(CLI.cdpPort || process.env.CDP_PORT || process.env.EDGE_CDP_PORT || 9222);
const BROWSER_CDP_URL = `http://127.0.0.1:${BROWSER_CDP_PORT}`;
const BROWSER_EXECUTABLE_PATH = CLI.browserPath || process.env.BROWSER_PATH || process.env.EDGE_PATH || "";
const BROWSER_USER_DATA_DIR = resolveInputPath(
	CLI.userDataDir || process.env.BROWSER_USER_DATA_DIR || process.env.EDGE_USER_DATA_DIR || `.browser-${BROWSER_NAME}-cdp-profile`,
	path.resolve(__dirname, `.browser-${BROWSER_NAME}-cdp-profile`)
);

// Build artifact config.
const DIST_DIR = resolveInputPath(CLI.distDir || process.env.DIST_DIR || path.resolve(__dirname, "dist"), path.resolve(__dirname, "dist"));
const EXTENSION_CONFIG_PATH = path.resolve(__dirname, "..", "extension.json");

// Continuous listener config.
const WATCH_INTERVAL_MS = Number(CLI.watchInterval || process.env.WATCH_INTERVAL_MS || 1200);
const INSTALL_ON_WATCH_START = (CLI.installOnWatchStart || process.env.INSTALL_ON_WATCH_START || "1") !== "0";

// Default window geometry for spawned browser (non-fullscreen).
const BROWSER_WINDOW_WIDTH = Number(CLI.windowWidth || process.env.BROWSER_WINDOW_WIDTH || process.env.EDGE_WINDOW_WIDTH || 1366);
const BROWSER_WINDOW_HEIGHT = Number(CLI.windowHeight || process.env.BROWSER_WINDOW_HEIGHT || process.env.EDGE_WINDOW_HEIGHT || 860);
const BROWSER_WINDOW_X = Number(CLI.windowX || process.env.BROWSER_WINDOW_X || process.env.EDGE_WINDOW_X || 120);
const BROWSER_WINDOW_Y = Number(CLI.windowY || process.env.BROWSER_WINDOW_Y || process.env.EDGE_WINDOW_Y || 80);

// Prefer stable selectors (data-test / prefix match) over hashed class names.
const SELECTORS = {
	userAvatarBox: "#userAvatarBox",
	usernameSpan: "#loginUsername span",
	modalMask: 'div[class*="lc_modal_mask_"], div[data-test="modal-mask"]',
	modalClose: '[data-test="close"][class*="header_right_close_"], [data-test="close"]',
	advancedButton: 'span[data-test="Advanced"]',
	advancedMenu: "#mm-common-advanced",
	extensionsManagerEntry: '#mm-common-advanced span[data-test="Extensions Manager..."]',
	importInput: 'button[data-test="Import"] input[type="file"], input[type="file"][accept*=".eext"]',
	closeExtensionsButton: 'button[data-test="Close"], button[title="关闭"]'
};

function printResult(result) {
	console.log(`URL: ${TARGET_URL}`);
	console.log(`Logged in: ${result.isLoggedIn ? "YES" : "NO"}`);
	console.log(`Reason: ${result.reason}`);
	console.log(`Display: ${result.display || "(empty)"}`);
	console.log(`Username: ${result.username || "(empty)"}`);
	if (result.href) {
		console.log(`Href: ${result.href}`);
	}
}

function waitForEnter(prompt) {
	return new Promise((resolve) => {
		process.stdout.write(prompt);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", () => resolve());
	});
}

async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(ts) {
	return new Date(ts).toLocaleString();
}

function createArtifactInfo(filePath) {
	const stat = fs.statSync(filePath);
	return {
		filePath,
		size: stat.size,
		ctimeMs: stat.ctimeMs,
		mtimeMs: stat.mtimeMs,
		key: `${filePath}|${Math.trunc(stat.ctimeMs)}|${Math.trunc(stat.mtimeMs)}|${stat.size}`
	};
}

function getExpectedPackagePathFromConfig() {
	const extensionConfig = JSON.parse(fs.readFileSync(EXTENSION_CONFIG_PATH, "utf8"));
	const expectedName = `${extensionConfig.name}_v${extensionConfig.version}.eext`;
	return path.join(DIST_DIR, expectedName);
}

function getCurrentPackageInfo() {
	// Keep naming rule consistent with build/packaged.ts:
	// dist/${extensionConfig.name}_v${extensionConfig.version}.eext
	try {
		const expectedPath = getExpectedPackagePathFromConfig();
		if (fs.existsSync(expectedPath)) {
			return createArtifactInfo(expectedPath);
		}
	} catch {
		// Fall through to dist scan below.
	}

	if (fs.existsSync(DIST_DIR)) {
		const candidates = fs
			.readdirSync(DIST_DIR, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".eext"))
			.map((entry) => path.join(DIST_DIR, entry.name));

		if (candidates.length > 0) {
			candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
			return createArtifactInfo(candidates[0]);
		}
	}

	throw new Error(
		`Import package not found. Expected naming from extension.json in ${DIST_DIR}, or at least one .eext file in dist.`
	);
}

async function connectCdpWithRetry(chromium, retries = 6, delayMs = 1000) {
	let lastError;
	for (let i = 0; i < retries; i++) {
		try {
			return await chromium.connectOverCDP(BROWSER_CDP_URL);
		} catch (error) {
			lastError = error;
			if (i < retries - 1) {
				await sleep(delayMs);
			}
		}
	}
	throw lastError;
}

function getExecutableCandidates(browserName) {
	if (browserName === "msedge") {
		return [
			path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
			"msedge"
		];
	}

	if (browserName === "chrome") {
		return [
			path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
			path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
			"chrome"
		];
	}

	return [
		path.join(process.env.LOCALAPPDATA || "", "Chromium", "Application", "chrome.exe"),
		"chromium",
		"chrome",
		"msedge"
	];
}

// Resolve browser executable from CLI/env or common install paths.
function resolveBrowserExecutable() {
	if (BROWSER_EXECUTABLE_PATH) {
		if (
			(BROWSER_EXECUTABLE_PATH.includes("\\") || BROWSER_EXECUTABLE_PATH.includes("/") || BROWSER_EXECUTABLE_PATH.toLowerCase().endsWith(".exe"))
			&& !fs.existsSync(BROWSER_EXECUTABLE_PATH)
		) {
			throw new Error(`Browser executable not found: ${BROWSER_EXECUTABLE_PATH}`);
		}
		return BROWSER_EXECUTABLE_PATH;
	}

	const candidates = getExecutableCandidates(BROWSER_NAME);
	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		if (candidate.includes("\\") || candidate.includes("/") || candidate.toLowerCase().endsWith(".exe")) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} else {
			return candidate;
		}
	}

	throw new Error(`Unable to resolve executable for browser: ${BROWSER_NAME}`);
}

// Start standalone browser with CDP enabled.
function startBrowserWithCDP() {
	const browserExecutable = resolveBrowserExecutable();
	const args = [
		`--remote-debugging-port=${BROWSER_CDP_PORT}`,
		`--user-data-dir=${BROWSER_USER_DATA_DIR}`,
		`--window-size=${BROWSER_WINDOW_WIDTH},${BROWSER_WINDOW_HEIGHT}`,
		`--window-position=${BROWSER_WINDOW_X},${BROWSER_WINDOW_Y}`,
		"--new-window",
		"--disable-extensions",
		"--disable-component-extensions-with-background-pages",
		"--disable-sync",
		"--no-first-run",
		"--no-default-browser-check"
	];

	const child = spawn(browserExecutable, args, { detached: true, stdio: "ignore" });
	child.unref();
}

// Reuse existing CDP session when possible; spawn a new browser only as fallback.
async function createCdpSession(chromium) {
	let mode = "reuse";
	let browser = await connectCdpWithRetry(chromium, 2, 400).catch(() => null);

	if (!browser) {
		startBrowserWithCDP();
		browser = await connectCdpWithRetry(chromium, 12, 1000);
		mode = "spawn";
	}

	const context = browser.contexts()[0];
	if (!context) {
		throw new Error("No browser context available in CDP session");
	}

	return { browser, context, mode };
}

// Reuse an existing target/new-tab page first to avoid creating extra tabs.
function pickReusablePage(context) {
	const pages = context.pages();
	if (pages.length === 0) {
		return null;
	}

	const targetPage = pages.find((p) => (p.url() || "").startsWith(TARGET_ORIGIN));
	if (targetPage) {
		return targetPage;
	}

	const neutralPage = pages.find((p) => {
		const url = p.url() || "";
		return url === "about:blank" || url.startsWith("edge://newtab") || url.startsWith("chrome://newtab");
	});
	if (neutralPage) {
		return neutralPage;
	}

	return pages[0];
}

async function ensureTargetPageReady(page, mode) {
	const currentUrl = page.url() || "";
	const forceNavigate = process.env.FORCE_NAVIGATE === "1";
	const alreadyOnTargetSite = currentUrl.startsWith(TARGET_ORIGIN);

	// In reuse mode we avoid forced refresh to preserve current manual operations.
	if (mode === "reuse" && alreadyOnTargetSite && !forceNavigate) {
		console.log(`Navigation: keep current page without reload -> ${currentUrl}`);
		return;
	}

	console.log(`Navigation: goto ${TARGET_URL}`);
	await page.goto(TARGET_URL, { waitUntil: "load", timeout: 60000 });
	await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

// Try to grant local-fonts permission to reduce popup interruptions.
async function grantFontPermission(context) {
	try {
		await context.grantPermissions(["local-fonts"], { origin: TARGET_ORIGIN });
		console.log(`Permission: local-fonts granted for ${TARGET_ORIGIN}`);
	} catch {
		console.warn("Permission: failed to grant local-fonts automatically.");
	}
}

// Logged-in rule: avatar box is visible and username text is non-empty.
async function evaluateLoginState(page) {
	await page.waitForSelector(SELECTORS.userAvatarBox, { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(1000);

	return page.evaluate((selectors) => {
		const box = document.querySelector(selectors.userAvatarBox);
		if (!box) {
			return {
				isLoggedIn: false,
				reason: "Missing #userAvatarBox",
				href: null,
				username: "",
				display: ""
			};
		}

		const link = box.querySelector("a");
		if (!link) {
			return {
				isLoggedIn: false,
				reason: "No <a> under #userAvatarBox",
				href: null,
				username: "",
				display: ""
			};
		}

		const display = window.getComputedStyle(box).display || "";
		const inlineStyle = (box.getAttribute("style") || "").toLowerCase();
		const isVisible = display !== "none" && !inlineStyle.includes("display: none");
		const username = (box.querySelector(selectors.usernameSpan)?.textContent || "").trim();
		const href = link.getAttribute("href");
		const isLoggedIn = isVisible && username.length > 0;

		let reason = "Avatar box hidden or empty user info";
		if (isLoggedIn) {
			reason = "Avatar box visible and username is present";
		} else if (!isVisible) {
			reason = "Avatar box is hidden (display: none)";
		} else if (!username) {
			reason = "Username is empty";
		}

		return { isLoggedIn, reason, href, username, display };
	}, SELECTORS);
}

// Close blocking modal masks first; capped loop prevents infinite retries.
async function closeBlockingModalIfPresent(page) {
	let closedCount = 0;

	for (let i = 0; i < 5; i++) {
		const mask = page.locator(`${SELECTORS.modalMask}:visible`).first();
		if ((await mask.count()) === 0) {
			break;
		}

		const localClose = mask.locator("xpath=..").locator(SELECTORS.modalClose).first();
		const globalClose = page.locator(`${SELECTORS.modalClose}:visible`).first();
		const button = (await localClose.count()) > 0 ? localClose : globalClose;

		if ((await button.count()) === 0) {
			console.warn("Warning: modal mask found, but close button was not found.");
			break;
		}

		await button.click({ timeout: 5000 });
		closedCount += 1;
		await page.waitForTimeout(250);
	}

	if (closedCount > 0) {
		console.log(`Action: closed ${closedCount} blocking modal(s)`);
	}
}

async function openExtensionsManagerFromAdvanced(page) {
	const advancedButton = page.locator(SELECTORS.advancedButton).first();
	await advancedButton.waitFor({ state: "visible", timeout: 15000 });
	await advancedButton.click({ timeout: 10000 });

	const advancedMenu = page.locator(SELECTORS.advancedMenu);
	await advancedMenu.waitFor({ state: "visible", timeout: 10000 });

	const extensionsManagerEntry = page.locator(SELECTORS.extensionsManagerEntry).first();
	await extensionsManagerEntry.waitFor({ state: "visible", timeout: 10000 });
	await extensionsManagerEntry.click({ timeout: 10000 });
	console.log("Action: clicked Advanced -> Extensions Manager");
}

async function importExtensionPackage(page, importFilePath) {
	if (!fs.existsSync(importFilePath)) {
		throw new Error(`Import file not found: ${importFilePath}`);
	}

	const importInput = page.locator(SELECTORS.importInput).first();
	await importInput.waitFor({ state: "attached", timeout: 15000 });
	await importInput.setInputFiles(importFilePath);
	console.log(`Action: imported extension package -> ${importFilePath}`);
}

async function closeExtensionsManager(page) {
	const closeButton = page.locator(SELECTORS.closeExtensionsButton).first();
	await closeButton.waitFor({ state: "visible", timeout: 15000 });
	await closeButton.click({ timeout: 10000 });
	console.log("Action: clicked Close button in Extensions Manager");
}

// Post-login operation chain.
async function runPostLoginActions(page, importFilePath) {
	await closeBlockingModalIfPresent(page);
	await openExtensionsManagerFromAdvanced(page);
	await importExtensionPackage(page, importFilePath);
	await closeExtensionsManager(page);
}

async function installPackageWithLogin(artifactInfo) {
	let chromium;
	try {
		({ chromium } = require("playwright"));
	} catch {
		console.error("Missing dependency: playwright");
		console.error("Install it with: pnpm add -D playwright");
		process.exitCode = 1;
		return;
	}

	let browser;
	try {
		const session = await createCdpSession(chromium);
		browser = session.browser;

		if (session.mode === "reuse") {
			console.log(`Mode: Reuse existing ${BROWSER_NAME} CDP session (no extra window)`);
		} else {
			console.log(`Mode: Spawn new ${BROWSER_NAME} with CDP (extensions disabled, browser will stay open)`);
			console.log(`Window: ${BROWSER_WINDOW_WIDTH}x${BROWSER_WINDOW_HEIGHT} at (${BROWSER_WINDOW_X}, ${BROWSER_WINDOW_Y})`);
		}

		const page = pickReusablePage(session.context) || (await session.context.newPage());
		await grantFontPermission(session.context);
		await ensureTargetPageReady(page, session.mode);

		let result = await evaluateLoginState(page);
		printResult(result);

		if (!result.isLoggedIn) {
			await waitForEnter("Not logged in yet. Login in browser, then press Enter to re-check...");
			result = await evaluateLoginState(page);
			console.log("Re-check result:");
			printResult(result);
		}

		if (result.isLoggedIn) {
			await runPostLoginActions(page, artifactInfo.filePath);
		} else {
			console.warn("Install skipped because user is still not logged in.");
		}
	} finally {
		process.stdin.pause();
		// Disconnect CDP only; keep browser window open.
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

async function runWatchMode() {
	console.log(`Auto-install listener enabled. Interval: ${WATCH_INTERVAL_MS}ms`);
	console.log(`Browser: ${BROWSER_NAME}`);
	console.log(`CDP endpoint: ${BROWSER_CDP_URL}`);
	console.log(`User data dir: ${BROWSER_USER_DATA_DIR}`);
	console.log(`Watching dist directory: ${DIST_DIR}`);
	console.log(`Queue policy: keep only one pending install and always overwrite with latest build.`);

	let lastSeenKey = null;
	let lastInstalledKey = null;
	let isInstalling = false;
	let pendingArtifact = null;

	const triggerInstall = async (artifactInfo, reason) => {
		if (isInstalling) {
			const replaced = pendingArtifact !== null;
			pendingArtifact = artifactInfo;
			console.log(
				`Queue: ${replaced ? "replace pending with newer build" : "record one pending build"} -> ${path.basename(artifactInfo.filePath)}`
			);
			return;
		}

		isInstalling = true;
		let current = artifactInfo;
		let currentReason = reason;

		while (current) {
			console.log(
				`Install start [${currentReason}] => ${path.basename(current.filePath)} (ctime=${formatTime(current.ctimeMs)})`
			);
			try {
				await installPackageWithLogin(current);
				lastInstalledKey = current.key;
				console.log(`Install done => ${path.basename(current.filePath)}`);
			} catch (error) {
				console.error("Install failed:");
				console.error(error);
			}

			if (pendingArtifact) {
				current = pendingArtifact;
				pendingArtifact = null;
				currentReason = "pending-latest";

				if (current.key === lastInstalledKey) {
					current = null;
				}
			} else {
				current = null;
			}
		}

		isInstalling = false;
	};

	if (INSTALL_ON_WATCH_START) {
		try {
			const initialArtifact = getCurrentPackageInfo();
			lastSeenKey = initialArtifact.key;
			await triggerInstall(initialArtifact, "startup");
		} catch {
			console.warn("Startup install skipped: no artifact found yet.");
		}
	}

	setInterval(() => {
		let artifact;
		try {
			artifact = getCurrentPackageInfo();
		} catch {
			return;
		}

		if (artifact.key === lastSeenKey) {
			return;
		}

		lastSeenKey = artifact.key;
		if (artifact.key === lastInstalledKey && !isInstalling) {
			return;
		}

		console.log(
			`Detected new build artifact => ${path.basename(artifact.filePath)} (ctime=${formatTime(artifact.ctimeMs)}, mtime=${formatTime(artifact.mtimeMs)})`
		);
		void triggerInstall(artifact, "artifact-changed");
	}, WATCH_INTERVAL_MS);

	await new Promise(() => {});
}

async function main() {
	await runWatchMode();
}

main().catch((error) => {
	console.error("Failed to run installer.");
	console.error(error);
	process.exitCode = 1;
});

