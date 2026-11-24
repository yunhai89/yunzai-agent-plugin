/**
 * 前端构建产物回归：web/ 必须是可以被 Express 直接托管的完整静态站点。
 * 运行：node model/web/web-build.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionAssetUrls } from './asset-version.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const web = path.join(root, 'web')
let passed = 0, failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

console.log('[web build]')
ok(fs.existsSync(path.join(web, 'index.html')), 'web/index.html 存在')
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
ok(html.includes('id="root"'), 'index.html 含 React 挂载点')
ok(/<script[^>]+src="\.?\/?assets\/[^"]+\.js"/.test(html), 'index.html 引用构建后的 JS')
ok(/<link[^>]+href="\.?\/?assets\/[^"]+\.css"/.test(html), 'index.html 引用构建后的 CSS')
ok(/name="color-scheme" content="light"/.test(html), '只声明浅色配色')
ok(!/data-theme="dark"|color-scheme"\s+content="dark/.test(html), '不包含暗色主题声明')

const assets = html.match(/["'](\.?\/?assets\/[^"']+)["']/g) || []
ok(assets.length >= 2, '至少引用 JS 与 CSS')
for (const raw of assets) {
  const rel = raw.replace(/^["']|["']$/g, '').replace(/^\.?\//, '')
  const file = path.join(web, rel)
  ok(fs.existsSync(file), `资源存在：${rel}`)
}
const versioned = versionAssetUrls(html, '1.0.0-test')
ok(/assets\/[^"']+\.css\?v=1\.0\.0-test/.test(versioned), '版本查询串能追加到 Vite CSS 产物')
ok(!/assets\/[^"']+\.js\?v=/.test(versioned), 'module JS 入口不加查询串（防双份 React）')

const files = fs.readdirSync(path.join(web, 'assets'))
ok(files.some((f) => f.endsWith('.woff2')), '本地字体随构建产物分发')
ok(files.some((f) => f.endsWith('.js')), 'JS 产物在 assets/')

console.log('\n========================================')
console.log(`通过 ${passed}，失败 ${failed}`)
console.log('========================================')
if (failed > 0) process.exitCode = 1
