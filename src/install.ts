import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  MINI_CODE_SETTINGS_PATH,
  loadEffectiveSettings,
  saveMiniCodeSettings,
} from './config.js'

function hasPathEntry(target: string): boolean {
  const pathEntries = (process.env.PATH ?? '').split(':')
  return pathEntries.includes(target)
}

async function askRequired(
  nextLine: () => Promise<string | null>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    process.stdout.write(`${label}${suffix}: `)
    const incoming = await nextLine()
    const answer = (incoming ?? '').trim()
    const value = answer || defaultValue || ''
    if (value) return value
    console.log('该项不能为空，请重新输入。')
  }
}

function secretPromptSuffix(secret?: string): string {
  if (!secret) return ' [not set]'
  return ' [saved]'
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    const iterator = rl[Symbol.asyncIterator]()
    const nextLine = async (): Promise<string | null> => {
      const result = await iterator.next()
      return result.done ? null : result.value
    }

    const settings = await loadEffectiveSettings()
    const currentEnv = settings.env ?? {}

    console.log('mini-code installer')
    console.log(`配置会写入 ${MINI_CODE_SETTINGS_PATH}`)
    console.log('配置保存在独立目录中，不会影响其它本地工具配置。')
    console.log('')

    const model = await askRequired(
      nextLine,
      'Model name',
      settings.model ? String(settings.model) : String(currentEnv.ANTHROPIC_MODEL ?? ''),
    )
    const baseUrl = await askRequired(
      nextLine,
      'ANTHROPIC_BASE_URL',
      String(currentEnv.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'),
    )
    const savedAuthToken = String(currentEnv.ANTHROPIC_AUTH_TOKEN ?? '')
    process.stdout.write(`ANTHROPIC_AUTH_TOKEN${secretPromptSuffix(savedAuthToken)}: `)
    const tokenInput = ((await nextLine()) ?? '').trim()
    const authToken = tokenInput || savedAuthToken

    if (!authToken) {
      throw new Error('ANTHROPIC_AUTH_TOKEN 不能为空。')
    }

    await saveMiniCodeSettings({
      model,
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: model,
      },
    })

    const home = os.homedir()
    const targetBinDir = process.env.MINI_CODE_BIN_DIR
      ? path.resolve(process.env.MINI_CODE_BIN_DIR)
      : path.join(home, '.local', 'bin')
    const launcherPath = path.join(targetBinDir, 'minicode')
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const launcherScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `exec "${path.join(repoRoot, 'bin', 'minicode')}" "$@"`,
      '',
    ].join('\n')

    await mkdir(targetBinDir, { recursive: true })
    await writeFile(launcherPath, launcherScript, { mode: 0o755 })

    console.log('')
    console.log('安装完成。')
    console.log(`配置文件: ${MINI_CODE_SETTINGS_PATH}`)
    console.log(`启动命令: ${launcherPath}`)

    if (!hasPathEntry(targetBinDir)) {
      console.log('')
      console.log(`你的 PATH 里还没有 ${targetBinDir}`)
      console.log(`可以把下面这行加入 ~/.bashrc 或 ~/.zshrc:`)
      console.log(`export PATH="${targetBinDir}:$PATH"`)
    } else {
      console.log('')
      console.log('现在你可以在任意终端输入 `minicode` 启动。')
    }
  } finally {
    rl.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
