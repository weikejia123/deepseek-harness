#!/usr/bin/env node
// my-plus 插件仓库校验脚本
// 检查 plugins/ 下每个插件的 manifest 必填字段、id 与目录名一致性、idPrefix 格式，
// 以及 host.js / client.js 是否存在且能作为函数体解析（动态插件源码是函数体而非模块，
// 因此用 new Function 校验语法，不用 node --check）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const pluginsDir = join(root, 'plugins')
let failed = false
let checked = 0

if (!existsSync(pluginsDir)) {
  console.error('[error] 缺少 plugins/ 目录')
  process.exit(1)
}

for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const dir = entry.name
  const base = join(pluginsDir, dir)
  const manifestPath = join(base, 'manifest.json')
  const problems = []

  if (!existsSync(manifestPath)) {
    problems.push('缺少 manifest.json')
  } else {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (e) {
      problems.push('manifest.json 不是合法 JSON: ' + e.message)
      manifest = null
    }
    if (manifest) {
      for (const key of ['id', 'name', 'purpose', 'idPrefix']) {
        if (!manifest[key]) problems.push(`manifest 缺少必填字段 ${key}`)
      }
      if (manifest.id !== dir) problems.push(`manifest.id(${manifest.id}) 与目录名(${dir})不一致`)
      if (manifest.idPrefix && !/^[a-z]{3,6}$/.test(manifest.idPrefix)) {
        problems.push(`idPrefix(${manifest.idPrefix}) 必须是 3-6 位小写字母`)
      }
    }
  }

  const halves = ['host.js', 'client.js']
  const present = halves.filter((file) => existsSync(join(base, file)))
  if (present.length === 0) {
    problems.push('缺少 host.js 与 client.js（至少需要一半）')
  } else {
    for (const file of present) {
      const source = readFileSync(join(base, file), 'utf8')
      try {
        // 函数体语法校验：动态插件源码是 function body，允许顶层 return
        new Function(source)
      } catch (e) {
        problems.push(`${file} 语法错误: ${e.message}`)
      }
    }
    for (const file of halves.filter((f) => !present.includes(f))) {
      console.log(`  [info] ${dir}: 缺少 ${file}（单半区插件，忽略）`)
    }
  }

  if (problems.length > 0) {
    failed = true
    console.error(`[error] ${dir}`)
    for (const p of problems) console.error(`  - ${p}`)
  } else {
    checked += 1
    const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name || dir
    console.log(`[ok] ${dir} (${name})`)
  }
}

console.log(`\n共校验 ${checked} 个插件${failed ? '，存在错误' : ''}`)
if (failed) process.exit(1)
