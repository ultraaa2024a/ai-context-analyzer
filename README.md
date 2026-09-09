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
