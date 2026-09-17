export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** 可测试时钟：测试可推进或设定时间以覆盖保留期限场景。 */
export class MutableClock implements Clock {
  #current: Date;

  constructor(iso: string) {
    this.#current = new Date(iso);
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  set(iso: string): void {
    this.#current = new Date(iso);
  }
}
