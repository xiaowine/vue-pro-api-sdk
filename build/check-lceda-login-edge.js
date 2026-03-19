const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Target editor page.
const TARGET_URL = "https://pro.lceda.cn/editor";
const TARGET_ORIGIN = new URL(TARGET_URL).origin;

// CDP connection config: try to reuse existing Edge first.
const EDGE_CDP_PORT = Number(process.env.EDGE_CDP_PORT || 9222);
const EDGE_CDP_URL = `http://127.0.0.1:${EDGE_CDP_PORT}`;
const EDGE_USER_DATA_DIR = path.resolve(__dirname, ".edge-cdp-profile");

// Build artifact config.
const DIST_DIR = path.resolve(__dirname, "dist");
const EXTENSION_CONFIG_PATH = path.resolve(__dirname, "..", "extension.json");

// Continuous listener config.
const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 1200);
const INSTALL_ON_WATCH_START = process.env.INSTALL_ON_WATCH_START !== "0";

// Default window geometry for spawned Edge (non-fullscreen).
const EDGE_WINDOW_WIDTH = Number(process.env.EDGE_WINDOW_WIDTH || 1366);
const EDGE_WINDOW_HEIGHT = Number(process.env.EDGE_WINDOW_HEIGHT || 860);
const EDGE_WINDOW_X = Number(process.env.EDGE_WINDOW_X || 120);
const EDGE_WINDOW_Y = Number(process.env.EDGE_WINDOW_Y || 80);

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
	// build/dist/${extensionConfig.name}_v${extensionConfig.version}.eext
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
			return await chromium.connectOverCDP(EDGE_CDP_URL);
		} catch (error) {
			lastError = error;
			if (i < retries - 1) {
				await sleep(delayMs);
			}
		}
	}
	throw lastError;
}

// Resolve Edge executable from EDGE_PATH or common install paths.
function resolveEdgeExecutable() {
	const envEdgePath = process.env.EDGE_PATH;
	if (envEdgePath && fs.existsSync(envEdgePath)) {
		return envEdgePath;
	}

	const candidates = [
		path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
		path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
		"msedge"
	];

	return candidates.find((item) => item && (item === "msedge" || fs.existsSync(item))) || "msedge";
}

// Start a standalone Edge with CDP enabled.
function startEdgeWithCDP() {
	const edgeExecutable = resolveEdgeExecutable();
	const args = [
		`--remote-debugging-port=${EDGE_CDP_PORT}`,
		`--user-data-dir=${EDGE_USER_DATA_DIR}`,
		`--window-size=${EDGE_WINDOW_WIDTH},${EDGE_WINDOW_HEIGHT}`,
		`--window-position=${EDGE_WINDOW_X},${EDGE_WINDOW_Y}`,
		"--new-window",
		"--disable-extensions",
		"--disable-component-extensions-with-background-pages",
		"--disable-sync",
		"--no-first-run",
		"--no-default-browser-check"
	];

	const child = spawn(edgeExecutable, args, { detached: true, stdio: "ignore" });
	child.unref();
}

// Reuse existing CDP session when possible; spawn a new browser only as fallback.
async function createCdpSession(chromium) {
	let mode = "reuse";
	let browser = await connectCdpWithRetry(chromium, 2, 400).catch(() => null);

	if (!browser) {
		startEdgeWithCDP();
		browser = await connectCdpWithRetry(chromium, 12, 1000);
		mode = "spawn";
	}

	const context = browser.contexts()[0];
	if (!context) {
		throw new Error("No browser context available in Edge CDP session");
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
		return url === "about:blank" || url.startsWith("edge://newtab");
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
			console.log("Mode: Reuse existing Edge CDP session (no extra window)");
		} else {
			console.log("Mode: Spawn new Edge with CDP (extensions disabled, browser will stay open)");
			console.log(`Window: ${EDGE_WINDOW_WIDTH}x${EDGE_WINDOW_HEIGHT} at (${EDGE_WINDOW_X}, ${EDGE_WINDOW_Y})`);
		}

		const page = pickReusablePage(session.context) || (await session.context.newPage());
		await grantFontPermission(session.context);
		await ensureTargetPageReady(page, session.mode);

		let result = await evaluateLoginState(page);
		printResult(result);

		if (!result.isLoggedIn) {
			await waitForEnter("Not logged in yet. Login in Edge, then press Enter to re-check...");
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
		// Disconnect CDP only; keep Edge window open.
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
}

async function runWatchMode() {
	console.log(`Auto-install listener enabled. Interval: ${WATCH_INTERVAL_MS}ms`);
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
		} catch (error) {
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
