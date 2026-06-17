interface Props {
  errors: string[];
}

export function TelemetryBanner({ errors }: Props) {
  if (!errors.length) return null;
  return (
    <div className="banner warn" role="alert">
      <div className="banner-title">Partial telemetry</div>
      <ul className="banner-errors">
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  );
}
