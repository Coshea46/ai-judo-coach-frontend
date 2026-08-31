import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import {
  createExampleJob,
  createUploadJob,
  getExamplePreviewUrl,
  getJob,
  submitUploadJob,
  uploadVideoToS3,
  type Clip,
  type ExampleType,
} from './api'
import {
  formatDuration,
  formatFileSize,
  validateVideo,
  type ValidatedVideo,
} from './video'
import './App.css'

type View = 'home' | 'upload' | 'examples' | 'processing' | 'results'
type SetUpPhase = 'idle' | 'creating' | 'uploading' | 'submitting'
type JobSource = 'upload' | ExampleType

interface ActiveJob {
  jobId: string
  source: JobSource
  label: string
  startedAt: number
}

interface StoredJob {
  jobId: string
  source: JobSource
  label: string
  startedAt: number
}

const SESSION_JOB_KEY = 'ai-judo-coach-active-job'
const POLL_INTERVAL_MS = 5_000
const JOB_TIMEOUT_MS = 60 * 60 * 1_000

function readStoredJob(): StoredJob | null {
  try {
    const rawValue = sessionStorage.getItem(SESSION_JOB_KEY)

    if (!rawValue) {
      return null
    }

    const value = JSON.parse(rawValue) as Partial<StoredJob>

    if (
      typeof value.jobId !== 'string' ||
      typeof value.label !== 'string' ||
      typeof value.startedAt !== 'number' ||
      !['upload', 'short', 'full'].includes(value.source ?? '')
    ) {
      sessionStorage.removeItem(SESSION_JOB_KEY)
      return null
    }

    return value as StoredJob
  } catch {
    sessionStorage.removeItem(SESSION_JOB_KEY)
    return null
  }
}

function saveJob(job: ActiveJob): void {
  sessionStorage.setItem(SESSION_JOB_KEY, JSON.stringify(job))
}

function clearStoredJob(): void {
  sessionStorage.removeItem(SESSION_JOB_KEY)
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(resolve, milliseconds)

    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeoutId)
        reject(new DOMException('Polling was cancelled.', 'AbortError'))
      },
      { once: true },
    )
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.'
}

function App() {
  const [restoredJob] = useState<StoredJob | null>(() => readStoredJob())
  const validationRequestRef = useRef(0)
  const operationControllerRef = useRef<AbortController | null>(null)

  const [view, setView] = useState<View>(
    restoredJob ? 'processing' : 'home',
  )
  const [selectedVideo, setSelectedVideo] =
    useState<ValidatedVideo | null>(null)
  const [selectedExample, setSelectedExample] =
    useState<ExampleType>('short')
  const [validationPending, setValidationPending] = useState(false)
  const [setUpPhase, setSetUpPhase] = useState<SetUpPhase>('idle')
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(
    restoredJob,
  )
  const [clips, setClips] = useState<Clip[]>([])
  const [error, setError] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!activeJob) {
      return
    }

    const controller = new AbortController()

    const poll = async () => {
      try {
        while (!controller.signal.aborted) {
          if (Date.now() - activeJob.startedAt >= JOB_TIMEOUT_MS) {
            throw new Error(
              'Processing has taken longer than expected. Please start again.',
            )
          }

          const job = await getJob(activeJob.jobId, controller.signal)

          if (job.status === 'completed') {
            clearStoredJob()
            setClips(job.clips ?? [])
            setActiveJob(null)
            setView('results')
            return
          }

          if (job.status === 'failed') {
            throw new Error(
              job.error || 'The video could not be processed. Please try again.',
            )
          }

          await wait(POLL_INTERVAL_MS, controller.signal)
        }
      } catch (pollError) {
        if (
          pollError instanceof DOMException &&
          pollError.name === 'AbortError'
        ) {
          return
        }

        clearStoredJob()
        setActiveJob(null)
        setError(getErrorMessage(pollError))
        setView('home')
      }
    }

    void poll()

    return () => {
      controller.abort()
    }
  }, [activeJob])

  useEffect(() => {
    if (!activeJob) {
      return
    }

    const updateElapsedTime = () => {
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - activeJob.startedAt) / 1000)),
      )
    }

    updateElapsedTime()

    const intervalId = window.setInterval(updateElapsedTime, 1_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeJob])

  useEffect(() => {
    return () => {
      operationControllerRef.current?.abort()
    }
  }, [])

  const reset = () => {
    validationRequestRef.current += 1
    operationControllerRef.current?.abort()
    operationControllerRef.current = null
    clearStoredJob()
    setSelectedVideo(null)
    setSelectedExample('short')
    setValidationPending(false)
    setSetUpPhase('idle')
    setActiveJob(null)
    setClips([])
    setError(null)
    setElapsedSeconds(0)
    setView('home')
  }

  const chooseView = (
    nextView: 'home' | 'upload' | 'examples',
  ) => {
    setError(null)
    setView(nextView)
  }

  const handleFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0] ?? null
    const requestId = validationRequestRef.current + 1

    validationRequestRef.current = requestId
    setSelectedVideo(null)
    setError(null)

    if (!file) {
      setValidationPending(false)
      return
    }

    setValidationPending(true)

    try {
      const video = await validateVideo(file)

      if (validationRequestRef.current === requestId) {
        setSelectedVideo(video)
      }
    } catch (validationError) {
      if (validationRequestRef.current === requestId) {
        setError(getErrorMessage(validationError))
        event.target.value = ''
      }
    } finally {
      if (validationRequestRef.current === requestId) {
        setValidationPending(false)
      }
    }
  }

  const beginPolling = (
    jobId: string,
    source: JobSource,
    label: string,
  ) => {
    const job: ActiveJob = {
      jobId,
      source,
      label,
      startedAt: Date.now(),
    }

    saveJob(job)
    setElapsedSeconds(0)
    setActiveJob(job)
    setSetUpPhase('idle')
    setError(null)
    setView('processing')
  }

  const processUpload = async () => {
    if (!selectedVideo || setUpPhase !== 'idle') {
      return
    }

    const controller = new AbortController()
    operationControllerRef.current = controller
    setError(null)

    try {
      setSetUpPhase('creating')
      const createdJob = await createUploadJob(controller.signal)

      setSetUpPhase('uploading')
      await uploadVideoToS3(
        createdJob.upload,
        selectedVideo.file,
        controller.signal,
      )

      setSetUpPhase('submitting')
      await submitUploadJob(createdJob.job_id, controller.signal)

      operationControllerRef.current = null
      beginPolling(createdJob.job_id, 'upload', selectedVideo.file.name)
    } catch (uploadError) {
      if (
        uploadError instanceof DOMException &&
        uploadError.name === 'AbortError'
      ) {
        return
      }

      setError(getErrorMessage(uploadError))
      setSetUpPhase('idle')
      operationControllerRef.current = null
    }
  }

  const processExample = async () => {
    if (setUpPhase !== 'idle') {
      return
    }

    const controller = new AbortController()
    operationControllerRef.current = controller
    setSetUpPhase('creating')
    setError(null)

    try {
      const createdJob = await createExampleJob(
        selectedExample,
        controller.signal,
      )

      operationControllerRef.current = null
      beginPolling(
        createdJob.job_id,
        selectedExample,
        selectedExample === 'short' ? 'Short excerpt' : 'Full match',
      )
    } catch (exampleError) {
      if (
        exampleError instanceof DOMException &&
        exampleError.name === 'AbortError'
      ) {
        return
      }

      setError(getErrorMessage(exampleError))
      setSetUpPhase('idle')
      operationControllerRef.current = null
    }
  }

  return (
    <div className="app-shell">
      <Header onHome={reset} />

      <main>
        {error && (
          <div className="alert alert-error" role="alert">
            <div>
              <strong>Something went wrong</strong>
              <p>{error}</p>
            </div>
            <button
              type="button"
              className="alert-close"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {view === 'home' && (
          <Home
            onUpload={() => chooseView('upload')}
            onExamples={() => chooseView('examples')}
          />
        )}

        {view === 'upload' && (
          <UploadView
            video={selectedVideo}
            validationPending={validationPending}
            setUpPhase={setUpPhase}
            onFileChange={handleFileChange}
            onSubmit={() => void processUpload()}
            onBack={() => chooseView('home')}
          />
        )}

        {view === 'examples' && (
          <ExamplesView
            selectedExample={selectedExample}
            setUpPhase={setUpPhase}
            onSelect={setSelectedExample}
            onSubmit={() => void processExample()}
            onBack={() => chooseView('home')}
          />
        )}

        {view === 'processing' && activeJob && (
          <ProcessingView
            job={activeJob}
            elapsedSeconds={elapsedSeconds}
            onReset={reset}
          />
        )}

        {view === 'results' && (
          <Results clips={clips} onReset={reset} />
        )}
      </main>

      <Footer />
    </div>
  )
}

function Header({ onHome }: { onHome: () => void }) {
  return (
    <header className="site-header">
      <button type="button" className="brand" onClick={onHome}>
        <img
          className="brand-mark"
          src="/favicon.svg"
          width="34"
          height="34"
          alt=""
          aria-hidden="true"
        />
        <span>AI Judo Coach</span>
      </button>
    </header>
  )
}

function Home({
  onUpload,
  onExamples,
}: {
  onUpload: () => void
  onExamples: () => void
}) {
  return (
    <>
      <section className="hero-section">
        <p className="eyebrow">Judo video analysis</p>
        <h1>Find the key moments in your match</h1>
        <p className="hero-copy">
          Upload a match and AI Judo Coach will find likely throw attempts,
          then extract them into clips you can review.
        </p>

        <div className="hero-actions">
          <button type="button" className="button primary" onClick={onUpload}>
            Upload your video
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={onExamples}
          >
            Try an example
          </button>
        </div>

        <p className="hero-note">
          MP4 videos up to 30 minutes and 2 GiB are supported.
        </p>
      </section>

      <section className="how-it-works" aria-labelledby="how-heading">
        <h2 id="how-heading">How it works</h2>
        <ol className="steps-grid">
          <li>
            <span>1</span>
            <div>
              <strong>Choose a match</strong>
              <p>Upload your own MP4 or use one of the examples.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Let it process</strong>
              <p>Analysis can take several minutes depending on length.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Review the clips</strong>
              <p>Play each detected moment and open or download it.</p>
            </div>
          </li>
        </ol>
      </section>
    </>
  )
}

interface UploadViewProps {
  video: ValidatedVideo | null
  validationPending: boolean
  setUpPhase: SetUpPhase
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onSubmit: () => void
  onBack: () => void
}

function UploadView({
  video,
  validationPending,
  setUpPhase,
  onFileChange,
  onSubmit,
  onBack,
}: UploadViewProps) {
  const busy = setUpPhase !== 'idle'

  return (
    <PageCard
      eyebrow="Your match"
      title="Upload a video"
      description="Choose an MP4 from your computer or mobile device."
      onBack={onBack}
    >
      <label className="file-picker">
        <span className="file-picker-title">
          {validationPending ? 'Reading video…' : 'Choose an MP4 video'}
        </span>
        <span className="file-picker-note">
          Maximum duration 30 minutes · Maximum size 2 GiB
        </span>
        <input
          type="file"
          accept=".mp4,video/mp4"
          onChange={onFileChange}
          disabled={busy}
        />
      </label>

      {video && (
        <div className="selected-file" aria-live="polite">
          <div className="file-icon" aria-hidden="true">
            MP4
          </div>
          <div>
            <strong>{video.file.name}</strong>
            <p>
              {formatFileSize(video.file.size)} ·{' '}
              {formatDuration(video.durationSeconds)}
            </p>
          </div>
        </div>
      )}

      {busy && <SetUpProgress phase={setUpPhase} />}

      <div className="form-actions">
        <button
          type="button"
          className="button primary"
          disabled={!video || validationPending || busy}
          onClick={onSubmit}
        >
          {setUpPhase === 'creating' && 'Preparing upload…'}
          {setUpPhase === 'uploading' && 'Uploading video…'}
          {setUpPhase === 'submitting' && 'Starting analysis…'}
          {setUpPhase === 'idle' && 'Process video'}
        </button>
      </div>
    </PageCard>
  )
}

interface ExamplesViewProps {
  selectedExample: ExampleType
  setUpPhase: SetUpPhase
  onSelect: (example: ExampleType) => void
  onSubmit: () => void
  onBack: () => void
}

function ExamplesView({
  selectedExample,
  setUpPhase,
  onSelect,
  onSubmit,
  onBack,
}: ExamplesViewProps) {
  const busy = setUpPhase !== 'idle'

  return (
    <PageCard
      eyebrow="Demo videos"
      title="Choose an example"
      description="Preview either match before starting the analysis."
      onBack={onBack}
      wide
    >
      <div className="example-grid">
        <ExampleCard
          type="short"
          title="Short excerpt"
          time="Usually 2–3 minutes"
          selected={selectedExample === 'short'}
          disabled={busy}
          onSelect={onSelect}
        />
        <ExampleCard
          type="full"
          title="Full match"
          time="Usually about 9 minutes"
          selected={selectedExample === 'full'}
          disabled={busy}
          onSelect={onSelect}
        />
      </div>

      {busy && (
        <div className="starting-example" role="status">
          <span className="spinner" aria-hidden="true" />
          Preparing the example…
        </div>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onSubmit}
        >
          {busy
            ? 'Starting analysis…'
            : `Process ${
                selectedExample === 'short'
                  ? 'short excerpt'
                  : 'full match'
              }`}
        </button>
      </div>
    </PageCard>
  )
}

function ExampleCard({
  type,
  title,
  time,
  selected,
  disabled,
  onSelect,
}: {
  type: ExampleType
  title: string
  time: string
  selected: boolean
  disabled: boolean
  onSelect: (type: ExampleType) => void
}) {
  return (
    <article className={`example-card ${selected ? 'selected' : ''}`}>
      <video
        controls
        preload="metadata"
        src={getExamplePreviewUrl(type)}
        aria-label={`${title} preview`}
      >
        Your browser does not support video playback.
      </video>

      <label className="example-choice">
        <input
          type="radio"
          name="example"
          value={type}
          checked={selected}
          disabled={disabled}
          onChange={() => onSelect(type)}
        />
        <span className="radio-mark" aria-hidden="true" />
        <span>
          <strong>{title}</strong>
          <small>{time}</small>
        </span>
      </label>

      <VideoCredit type={type} />
    </article>
  )
}

function VideoCredit({ type }: { type: ExampleType }) {
  if (type === 'full') {
    return (
      <p className="video-credit">
        Video:{' '}
        <a
          href="https://commons.wikimedia.org/wiki/File:Emilia_Lopes_(CE)_X_Gabriela_Chibana_(SP)_-_Brasileiro_S%C3%AAnior_2017_-_Quartas_de_final.webm"
          target="_blank"
          rel="noopener noreferrer"
        >
          Emilia Lopes vs Gabriela Chibana (2017)
        </a>{' '}
        by Federação Cearense de Judô – FECJU, licensed under{' '}
        <a
          href="https://creativecommons.org/licenses/by/3.0/"
          target="_blank"
          rel="noopener noreferrer"
        >
          CC BY 3.0
        </a>
        . Trimmed from the original.
      </p>
    )
  }

  return (
    <p className="video-credit">
      Video:{' '}
      <a
        href="https://commons.wikimedia.org/wiki/File:Judo_2011_World_Championships_Paris-Rothberg_EST_Vs_Mendonca_BRA_-73kg.webm"
        target="_blank"
        rel="noopener noreferrer"
      >
        Kunter Rothberg vs Bruno Mendonca (2011)
      </a>{' '}
      by groulsHD, licensed under{' '}
      <a
        href="https://creativecommons.org/licenses/by/3.0/"
        target="_blank"
        rel="noopener noreferrer"
      >
        CC BY 3.0
      </a>
      . Clipped from the original (0:55–2:05).
    </p>
  )
}

function SetUpProgress({ phase }: { phase: SetUpPhase }) {
  const phases: SetUpPhase[] = ['creating', 'uploading', 'submitting']
  const activeIndex = phases.indexOf(phase)
  const labels = ['Preparing', 'Uploading video', 'Starting analysis']

  return (
    <ol className="compact-progress" aria-label="Upload progress">
      {labels.map((label, index) => (
        <li
          key={label}
          className={
            index < activeIndex
              ? 'complete'
              : index === activeIndex
                ? 'active'
                : ''
          }
        >
          <span aria-hidden="true">{index < activeIndex ? '✓' : index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function ProcessingView({
  job,
  elapsedSeconds,
  onReset,
}: {
  job: ActiveJob
  elapsedSeconds: number
  onReset: () => void
}) {
  const finalStageThreshold =
    job.source === 'short' ? 120 : job.source === 'full' ? 480 : 240
  const activeStage = elapsedSeconds >= finalStageThreshold ? 2 : 1

  const expectedTime =
    job.source === 'short'
      ? 'The short excerpt usually takes 2–3 minutes.'
      : job.source === 'full'
        ? 'The full match usually takes about 9 minutes.'
        : 'Processing time depends on the length of your video.'

  return (
    <section className="processing-panel" aria-labelledby="processing-title">
      <div className="processing-symbol" aria-hidden="true">
        <span />
      </div>

      <p className="eyebrow">Processing {job.label}</p>
      <h1 id="processing-title">Finding likely throw attempts</h1>
      <p className="processing-copy">
        {expectedTime} Keep this browser open or leave it running in the
        background until processing finishes.
      </p>

      <ol className="processing-steps" aria-label="Estimated processing stages">
        <ProgressStep
          number={1}
          title="Preparing video"
          detail="Video received and ready for analysis"
          state="complete"
        />
        <ProgressStep
          number={2}
          title="Analysing the match"
          detail="Looking for likely throw attempts"
          state={activeStage === 1 ? 'active' : 'complete'}
        />
        <ProgressStep
          number={3}
          title="Creating clips"
          detail="Preparing detected moments for review"
          state={activeStage === 2 ? 'active' : 'waiting'}
        />
      </ol>

      <p className="elapsed" role="status" aria-live="polite">
        Elapsed time: {formatDuration(elapsedSeconds)}
      </p>

      <button type="button" className="text-button" onClick={onReset}>
        Cancel and start again
      </button>
    </section>
  )
}

function ProgressStep({
  number,
  title,
  detail,
  state,
}: {
  number: number
  title: string
  detail: string
  state: 'complete' | 'active' | 'waiting'
}) {
  return (
    <li className={state}>
      <span className="progress-marker" aria-hidden="true">
        {state === 'complete' ? '✓' : number}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {state === 'active' && <span className="spinner" aria-hidden="true" />}
    </li>
  )
}

function Results({
  clips,
  onReset,
}: {
  clips: Clip[]
  onReset: () => void
}) {
  return (
    <section className="results-section" aria-labelledby="results-title">
      <p className="eyebrow">Analysis complete</p>
      <h1 id="results-title">
        {clips.length === 0
          ? 'No throw attempts detected'
          : `${clips.length} ${
              clips.length === 1 ? 'clip' : 'clips'
            } ready to review`}
      </h1>

      {clips.length === 0 ? (
        <div className="empty-state">
          <div aria-hidden="true">○</div>
          <p>
            No likely throw attempts were found in this video. You can try
            another match or one of the examples.
          </p>
        </div>
      ) : (
        <>
          <p className="results-intro">
            Review each detected moment below. Clip links are temporary, so
            save any clips you want to keep.
          </p>

          <div className="clips-grid">
            {clips.map((clip, index) => (
              <ClipCard key={clip.clip_id} clip={clip} index={index} />
            ))}
          </div>
        </>
      )}

      <button type="button" className="button primary" onClick={onReset}>
        Process another video
      </button>
    </section>
  )
}

function ClipCard({ clip, index }: { clip: Clip; index: number }) {
  const duration = Math.max(
    0,
    clip.end_time_seconds - clip.start_time_seconds,
  )

  return (
    <article className="clip-card">
      <video
        controls
        preload="metadata"
        src={clip.download_url}
        aria-label={`Clip ${index + 1}`}
      >
        Your browser does not support video playback.
      </video>

      <div className="clip-details">
        <div>
          <h2>Clip {index + 1}</h2>
          <p>
            {formatDuration(clip.start_time_seconds)}–
            {formatDuration(clip.end_time_seconds)} · {formatDuration(duration)}
          </p>
        </div>

        <a
          className="button small secondary"
          href={clip.download_url}
          target="_blank"
          rel="noreferrer"
        >
          Open clip
          <span className="sr-only"> {index + 1} in a new tab</span>
        </a>
      </div>
    </article>
  )
}

function PageCard({
  eyebrow,
  title,
  description,
  onBack,
  wide = false,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  onBack: () => void
  wide?: boolean
  children: ReactNode
}) {
  return (
    <section className={`page-card ${wide ? 'wide' : ''}`}>
      <button type="button" className="back-button" onClick={onBack}>
        <span aria-hidden="true">←</span> Back
      </button>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="page-description">{description}</p>
      {children}
    </section>
  )
}

function Footer() {
  return (
    <footer>
      <p>
        AI Judo Coach highlights likely moments for review. Its output is not
        definitive coaching, medical or safety advice.
      </p>
    </footer>
  )
}

export default App
