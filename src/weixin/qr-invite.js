/**
 * WeChat QR Code Invite Flow
 *
 * Direct HTTP calls to the ilinkai.weixin.qq.com API to generate
 * QR codes for tenant onboarding, bypassing the TS-based openclaw-weixin plugin.
 *
 * Flow:
 * 1. fetchQRCode() → get QR image URL
 * 2. pollQRStatus() → long-poll for scan result
 * 3. On confirmed → return userId (peer ID) for tenant registration
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../utils/logger.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const POLL_TIMEOUT_MS = 35_000; // client-side timeout for long-poll
const MAX_QR_REFRESH = 3;
const QR_TMP_DIR = "/tmp/openclaw/tenant-guard/qr";

/**
 * Generate a QR code PNG from a URL and save to a temp file.
 * Returns the local file path (e.g. /tmp/openclaw/tenant-guard/qr/qr-1234.png).
 * @param {string} content - The URL/string to encode in the QR code
 * @returns {Promise<string>} local file path
 */
async function generateQRCodeFile(content) {
  const { default: QRCode } = await import("qrcode");
  await mkdir(QR_TMP_DIR, { recursive: true });
  const filePath = join(QR_TMP_DIR, `qr-${Date.now()}.png`);
  await QRCode.toFile(filePath, content, { type: "png", width: 300, margin: 2 });
  log.info(`QR code PNG generated: ${filePath}`);
  return filePath;
}

/**
 * Fetch a new QR code from the WeChat API and generate a local PNG image.
 * @param {string} baseUrl - API base URL
 * @returns {Promise<{qrcode: string, qrcodeImgUrl: string}>}
 *   qrcodeImgUrl is now a local file path (e.g. /tmp/.../qr-xxx.png)
 */
export async function fetchQRCode(baseUrl = DEFAULT_BASE_URL) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`;
  log.info(`Fetching QR code from: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`QR code fetch failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const data = await response.json();
  // data.qrcode_img_content is an HTML landing page, not a direct image.
  // Generate a PNG locally from the scan URL so sendMedia can deliver it as an image.
  const qrcodeImgUrl = await generateQRCodeFile(data.qrcode_img_content);
  return {
    qrcode: data.qrcode,
    qrcodeImgUrl,
  };
}

/**
 * Poll QR code status (single long-poll request).
 * @param {string} baseUrl
 * @param {string} qrcode
 * @returns {Promise<{status: string, botToken?: string, accountId?: string, baseUrl?: string, userId?: string}>}
 */
async function pollQRStatus(baseUrl, qrcode) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`QR status poll failed: ${response.status} - ${body}`);
    }

    const data = await response.json();
    return {
      status: data.status, // "wait" | "scaned" | "confirmed" | "expired"
      botToken: data.bot_token,
      accountId: data.ilink_bot_id,
      baseUrl: data.baseurl,
      userId: data.ilink_user_id,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

/**
 * Start an invite flow: fetch QR code and begin background polling.
 *
 * Returns the QR image URL immediately. Calls onResult callback when
 * the user scans and confirms, or when the flow times out/fails.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl] - API base URL
 * @param {number} [opts.timeoutMs=300000] - Total timeout (5 minutes)
 * @param {(result: {success: boolean, userId?: string, accountId?: string, message: string}) => void} opts.onResult
 * @returns {Promise<{qrcodeImgUrl: string, message: string} | {error: string}>}
 */
export async function startInviteFlow(opts) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs || 300_000;

  try {
    let qr = await fetchQRCode(baseUrl);
    if (!qr.qrcodeImgUrl) {
      return { error: "无法获取二维码，请稍后重试。" };
    }

    // Start background polling
    (async () => {
      const deadline = Date.now() + timeoutMs;
      let currentQrcode = qr.qrcode;
      let refreshCount = 0;

      while (Date.now() < deadline) {
        try {
          const status = await pollQRStatus(baseUrl, currentQrcode);

          switch (status.status) {
            case "wait":
              // Continue polling
              break;

            case "scaned":
              log.info("QR invite: user scanned, waiting for confirmation...");
              break;

            case "expired":
              refreshCount++;
              if (refreshCount >= MAX_QR_REFRESH) {
                opts.onResult({
                  success: false,
                  message: "二维码多次过期，邀请已取消。请重新发起邀请。",
                });
                return;
              }
              log.info(`QR invite: expired, refreshing (${refreshCount}/${MAX_QR_REFRESH})`);
              try {
                const newQr = await fetchQRCode(baseUrl);
                currentQrcode = newQr.qrcode;
                // Notify about new QR code
                opts.onRefresh?.({
                  qrcodeImgUrl: newQr.qrcodeImgUrl,
                  message: `⏳ 二维码已过期，已自动刷新 (${refreshCount}/${MAX_QR_REFRESH})`,
                });
              } catch (e) {
                opts.onResult({
                  success: false,
                  message: `刷新二维码失败: ${e.message}`,
                });
                return;
              }
              break;

            case "confirmed":
              log.info(`QR invite: confirmed! userId=${status.userId} accountId=${status.accountId}`);
              opts.onResult({
                success: true,
                userId: status.userId,
                accountId: status.accountId,
                message: "✅ 用户已扫码确认！",
              });
              return;
          }
        } catch (err) {
          log.error(`QR invite polling error: ${err.message}`);
          opts.onResult({
            success: false,
            message: `邀请轮询失败: ${err.message}`,
          });
          return;
        }

        // Brief pause between polls
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Timeout
      opts.onResult({
        success: false,
        message: "邀请超时（5 分钟），请重新发起邀请。",
      });
    })();

    return {
      qrcodeImgUrl: qr.qrcodeImgUrl,
      message: "使用微信扫描以下二维码，完成绑定。",
    };
  } catch (err) {
    log.error(`startInviteFlow error: ${err.message}`);
    return { error: `启动邀请失败: ${err.message}` };
  }
}
