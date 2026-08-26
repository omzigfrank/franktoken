import React from 'react'

/**
 * Last line of defence for the renderer.
 *
 * Without this, one unhandled exception anywhere in the tree unmounts
 * everything and the window goes blank — the worst possible failure for a
 * packaged desktop app, because there is no console to look at and nothing to
 * report beyond "it stopped working". A crash here shows what broke, keeps the
 * rest of the app reachable, and offers a reload.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Keep it in the console too, for anyone running from source.
    console.error('FrankToken renderer error:', error, info)
    this.setState({ info })
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    const detail = [
      String(error?.stack || error?.message || error),
      info?.componentStack ? `\nComponent stack:${info.componentStack}` : ''
    ].join('')

    return (
      <div className="crash">
        <div className="crash-card">
          <span>Something broke in the dashboard</span>
          <h2>{this.props.label ? `${this.props.label} failed to render` : 'Render error'}</h2>
          <p>
            The rest of the app still works — switch views in the sidebar, or reload. Your data is
            untouched; this is a display fault, not a loss of history.
          </p>
          <div className="crash-actions">
            <button className="rp-apply" onClick={() => window.location.reload()}>Reload</button>
            <button
              className="rp-btn"
              onClick={() => navigator.clipboard?.writeText(detail)}
            >
              Copy details
            </button>
            <button className="rp-btn" onClick={() => this.setState({ error: null, info: null })}>
              Try again
            </button>
          </div>
          <pre className="crash-detail">{detail.slice(0, 4000)}</pre>
        </div>
      </div>
    )
  }
}
