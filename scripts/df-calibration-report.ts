/**
 * Dark Factory — calibration report CLI (#490, epic #453).
 *
 * Reads recorded estimate/actual pairs and prints the signed bias, then MAE/MAPE by stage and cost
 * class, plus the multiplicative factor the estimator consumes in v2.
 *
 *   npm run df:calibration-report
 *   npm run df:calibration-report -- --period 2026-10
 *   npm run df:calibration-report -- --json --min-samples 5
 */
