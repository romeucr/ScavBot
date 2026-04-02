import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import { URL } from 'node:url'

const repoRoot = process.cwd()
const dataPath = path.join(repoRoot, 'src', 'abi', 'data.ts')
const imagesDir = path.join(repoRoot, 'docs', 'abi-images')
const mapPath = path.join(repoRoot, 'src', 'abi', 'imageMap.json')

if (!fs.existsSync(dataPath)) {
  console.error(`Missing ${dataPath}`)
  process.exit(1)
}

const content = fs.readFileSync(dataPath, 'utf-8')
const urlRegex = /imageUrl:\s*'([^']+)'/g
const urls = new Set()
let match
while ((match = urlRegex.exec(content)) !== null) {
  urls.add(match[1])
}

if (urls.size === 0) {
  console.log('No imageUrl entries found.')
  process.exit(0)
}

fs.mkdirSync(imagesDir, { recursive: true })

const imageMap = {}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function hash(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 8)
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed ${url}: ${res.statusCode}`))
        res.resume()
        return
      }
      const file = fs.createWriteStream(outPath)
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', reject)
  })
}

for (const url of urls) {
  const parsed = new URL(url)
  const filenameRaw = path.basename(parsed.pathname)
  const base = slugify(filenameRaw.replace(/\.(png|jpg|jpeg|webp)$/i, ''))
  const extMatch = filenameRaw.match(/\.(png|jpg|jpeg|webp)$/i)
  const ext = extMatch ? extMatch[0].toLowerCase() : '.png'
  const finalName = `${base}-${hash(url)}${ext}`
  const localPath = path.join(imagesDir, finalName)
  imageMap[url] = localPath
}

for (const [url, localPath] of Object.entries(imageMap)) {
  if (fs.existsSync(localPath)) continue
  console.log(`Downloading ${url}`)
  try {
    await download(url, localPath)
  } catch (err) {
    console.warn(`Failed to download ${url}: ${err.message}`)
  }
}

fs.writeFileSync(mapPath, JSON.stringify(imageMap, null, 2))
console.log(`Saved ${Object.keys(imageMap).length} mappings to ${mapPath}`)
