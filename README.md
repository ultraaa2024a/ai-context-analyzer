# AI Context Analyzer

An open-source, read-only analytics and diagnostic engine for YouTube channels.

The project combines official YouTube API data with transparent local heuristics to help creators and developers understand channel performance, compare content cohorts, detect patterns, and generate structured analytical reports.

## Features

- Read-only YouTube Data API and YouTube Analytics API access
- Channel and video performance analysis
- D1 / D3 / D7 / D14 / D28 lifecycle metrics
- Topic clustering and Topic DNA analysis
- Winner / Loser cohort comparison
- Duration and publishing-pattern analysis
- Retention and engagement diagnostics
- Data-quality and confidence scoring
- Local caching and run history
- JSON, TXT, HTML and CSV report generation
- Explicit separation between official API data and heuristic conclusions
- Protection against treating missing analytics data as zero

## Philosophy

Analytics tools should not pretend uncertain data is certain.

AI Context Analyzer marks low-confidence conclusions, distinguishes observed data from derived heuristics, and avoids fabricating unavailable YouTube metrics.

The goal is to make automated channel diagnostics reproducible, inspectable and useful for further research and development.

## Requirements

- Node.js 18 or newer
- Google Cloud project
- YouTube Data API v3 enabled
- YouTube Analytics API enabled
- OAuth 2.0 Desktop credentials

## Installation

```bash
git clone https://github.com/ultraaa2024a/ai-context-analyzer.git
cd ai-context-analyzer
npm install
```

## Run

```bash
npm start
```

Or:

```bash
node index_v4_3_1_final_verified_plus.js
```

## Authentication

The analyzer uses OAuth 2.0 with read-only scopes.

Local credentials and tokens must never be committed to the repository.

Files such as:

```text
oauth_client.local.json
token.local.json
expected_channel.local.json
```

are excluded through `.gitignore`.

## Privacy and safety

The project is designed as a read-only analytics tool.

It does not upload, modify or delete YouTube videos.

OAuth scopes are limited to:

```text
youtube.readonly
yt-analytics.readonly
```

Generated reports, tokens, local cache files and channel snapshots remain local by default.

## Project status

This is an early public open-source release of the V4.3.1 analytics engine.

The current code originated from a real-world YouTube channel analytics workflow and is being prepared for broader reusable open-source development.

Areas planned for further development include:

- easier multi-channel configuration
- automated tests
- improved documentation
- additional reporting modules
- broader analytics-provider support
- stronger statistical validation
- modularization of the analysis engine

## Contributing

Issues, testing, bug reports and pull requests are welcome.

If you find an incorrect assumption, API edge case, statistical problem or useful new diagnostic signal, please open an issue or submit a pull request.

## License

MIT License
