import type { OrdinaryFalJob } from "../../../desktop/shared/ordinaryFal";

const statusLabel = (job: OrdinaryFalJob) => {
  switch (job.status) {
    case "PREPARING":
      return "Preparing local inputs";
    case "NOT_SUBMITTED":
      return "Not submitted";
    case "SUBMITTING":
      return "Confirming submission";
    case "SUBMISSION_UNKNOWN":
      return "Submission unknown. Check fal history before submitting again.";
    case "SUBMITTED":
      return "Queued or processing on fal";
    case "CANCELLATION_REQUESTED":
      return "Cancellation requested";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed";
    case "COMPLETED":
      return "Importing result";
    case "INGESTED":
      if (job.placement === "ATTACHED") return "Added as a new render layer";
      if (job.placement === "UNATTACHED")
        return "Saved locally; not attached to the timeline";
      return "Placing result on the timeline";
  }
};

export const VideoEffectsHistory = ({
  title,
  history,
  jobs,
  showAttachedResults = false
}: {
  title: string;
  history: { isError: boolean; isPending: boolean };
  jobs: OrdinaryFalJob[];
  showAttachedResults?: boolean;
}) => (
  <section
    aria-label="Video effects history"
    className="space-y-2 border-t border-element-primary pt-3"
  >
    <h3 className="font-medium">{title}</h3>
    {history.isError ? (
      <p role="status">Could not read job history. Checking again…</p>
    ) : (
      !jobs.length && (
        <p className="text-glyph-secondary">
          {history.isPending
            ? "Checking job history…"
            : "No video effects jobs yet."}
        </p>
      )
    )}
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.id} title={job.id} className="space-y-1">
          <p>
            <strong>
              {job.kind === "video-edit" ? "Kling O1 edit" : "Topaz 2× upscale"}
            </strong>{" "}
            — {statusLabel(job)}
          </p>
          {job.error && <p className="break-words">{job.error}</p>}
          {job.warning && <p className="break-words">{job.warning}</p>}
          {job.status === "INGESTED" &&
            (showAttachedResults || job.placement === "UNATTACHED") &&
            job.assetIds.map((id) => (
              <video
                key={id}
                aria-label="Local video effect result"
                src={`mago-media://asset/${encodeURIComponent(id)}`}
                controls
                preload="none"
                className="max-h-48 max-w-full"
              />
            ))}
        </li>
      ))}
    </ul>
  </section>
);
