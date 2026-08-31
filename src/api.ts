export type ExampleType = 'short' | 'full'

export type JobStatus =
  | 'awaiting_upload'
  | 'processing'
  | 'completed'
  | 'failed'

export interface Clip {
  clip_id: string
  start_time_seconds: number
  end_time_seconds: number
  download_url: string
}

export interface JobResponse {
  job_id: string
  status: JobStatus
  clips: Clip[]
  error: string | null
}

interface UploadInstructions {
  url: string
  fields: Record<string, string>
}

interface CreateJobResponse {
  job_id: string
  status: 'awaiting_upload'
  upload: UploadInstructions
}

interface SubmitJobResponse {
  job_id: string
  status: 'processing'
}

const fallbackApiBaseUrl =
  'https://coshea46--ai-judo-coach-fastapi-app.modal.run'

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || fallbackApiBaseUrl
).replace(/\/+$/, '')

async function getErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: unknown
      error?: unknown
    }

    if (typeof body.detail === 'string') {
      return body.detail
    }

    if (typeof body.error === 'string') {
      return body.error
    }
  } catch {
    // The response did not contain readable JSON.
  }

  return `The service returned an unexpected response (${response.status}).`
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    })
  } catch {
    throw new Error(
      'The processing service could not be reached. Check your connection and try again.',
    )
  }

  if (!response.ok) {
    throw new Error(await getErrorMessage(response))
  }

  return (await response.json()) as T
}

export function createUploadJob(
  signal?: AbortSignal,
): Promise<CreateJobResponse> {
  return requestJson<CreateJobResponse>('/jobs', {
    method: 'POST',
    signal,
  })
}

export async function uploadVideoToS3(
  upload: UploadInstructions,
  originalFile: File,
  signal?: AbortSignal,
): Promise<void> {
  const formData = new FormData()

  Object.entries(upload.fields).forEach(([key, value]) => {
    formData.append(key, value)
  })

  const file =
    originalFile.type === 'video/mp4'
      ? originalFile
      : new File([originalFile], originalFile.name, {
          type: 'video/mp4',
          lastModified: originalFile.lastModified,
        })

  formData.append('file', file)

  let response: Response

  try {
    response = await fetch(upload.url, {
      method: 'POST',
      body: formData,
      signal,
    })
  } catch {
    throw new Error(
      'The video upload could not be completed. Check your connection and try again.',
    )
  }

  if (!response.ok) {
    throw new Error(
      `The video upload failed (${response.status}). Please try again.`,
    )
  }
}

export function submitUploadJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<SubmitJobResponse> {
  return requestJson<SubmitJobResponse>(
    `/jobs/${encodeURIComponent(jobId)}/submit`,
    {
      method: 'POST',
      signal,
    },
  )
}

export function createExampleJob(
  example: ExampleType,
  signal?: AbortSignal,
): Promise<SubmitJobResponse> {
  const query = new URLSearchParams({ example })

  return requestJson<SubmitJobResponse>(`/examples?${query.toString()}`, {
    method: 'POST',
    signal,
  })
}

export function getJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<JobResponse> {
  return requestJson<JobResponse>(`/jobs/${encodeURIComponent(jobId)}`, {
    signal,
  })
}

export function getExamplePreviewUrl(example: ExampleType): string {
  return `${API_BASE_URL}/examples/${example}/preview`
}
