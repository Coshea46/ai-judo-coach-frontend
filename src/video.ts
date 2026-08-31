export const MAX_VIDEO_DURATION_SECONDS = 1_800
export const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024

const METADATA_TIMEOUT_MS = 20_000

export interface ValidatedVideo {
  file: File
  durationSeconds: number
}

export async function validateVideo(file: File): Promise<ValidatedVideo> {
  if (!file.name.toLowerCase().endsWith('.mp4')) {
    throw new Error('Choose a video in MP4 format.')
  }

  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    throw new Error('Videos must be 2 GiB or smaller.')
  }

  const durationSeconds = await readVideoDuration(file)

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      'The video duration could not be read. Try another MP4 file.',
    )
  }

  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error('Videos must be 30 minutes or shorter.')
  }

  return {
    file,
    durationSeconds,
  }
}

function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)

    let settled = false

    const cleanUp = () => {
      window.clearTimeout(timeoutId)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
    }

    const finish = (callback: () => void) => {
      if (settled) {
        return
      }

      settled = true
      cleanUp()
      callback()
    }

    const timeoutId = window.setTimeout(() => {
      finish(() => {
        reject(
          new Error(
            'The video metadata took too long to load. Try another MP4 file.',
          ),
        )
      })
    }, METADATA_TIMEOUT_MS)

    video.preload = 'metadata'

    video.onloadedmetadata = () => {
      const duration = video.duration
      finish(() => resolve(duration))
    }

    video.onerror = () => {
      finish(() => {
        reject(
          new Error(
            'The video metadata could not be read. The file may be damaged or use an unsupported format.',
          ),
        )
      })
    }

    video.src = objectUrl
  })
}

export function formatDuration(totalSeconds: number): string {
  const roundedSeconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.floor((roundedSeconds % 3600) / 60)
  const seconds = roundedSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const decimalPlaces = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(decimalPlaces)} ${units[unitIndex]}`
}
