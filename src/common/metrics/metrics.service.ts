import { Injectable, Logger } from '@nestjs/common';

/**
 * Ops-safe metrics service.
 *
 * Emits counters and histograms for observability without leaking
 * secrets, raw key material, or PII. All metric labels are
 * constrained to a safe character set.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  /**
   * In-memory counter registry so exported values can be scraped/asserted.
   * Keyed by the sanitized metric name (which may include bounded labels).
   */
  private readonly counters = new Map<string, number>();

  /**
   * Increment a named counter by the given amount.
   * Labels are sanitized to be log-safe.
   */
  incrementCounter(name: string, value: number = 1): void {
    const safeName = this.sanitizeLabel(name);
    this.counters.set(safeName, (this.counters.get(safeName) ?? 0) + value);
    this.logger.debug(`counter_inc ${safeName}=${value}`);
  }

  /**
   * Read the current value of a counter (0 when never incremented).
   */
  getCounter(name: string): number {
    return this.counters.get(this.sanitizeLabel(name)) ?? 0;
  }

  /**
   * Snapshot of all counters, suitable for a scrape/export path.
   */
  getCounters(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /**
   * Record a histogram observation.
   */
  recordHistogram(name: string, value: number): void {
    const safeName = this.sanitizeLabel(name);
    this.logger.debug(`histogram ${safeName}=${value}`);
  }

  private sanitizeLabel(label: string): string {
    return label.replace(/[^A-Za-z0-9_:.-]/g, '_');
  }
}
