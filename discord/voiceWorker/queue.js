const {
    LOGIN_QUEUE_MAX_SIZE,
    RECOVERY_QUEUE_MAX_SIZE,
} = require("./config");

// ════════════════════════════════════════════════════════════════════════════
//  🚦  REGION 5: OPERATION QUEUE
// ════════════════════════════════════════════════════════════════════════════
class OperationQueue {
    constructor(concurrency = 3, maxQueueSize = 100, name = "operation") {
        this.queue = [];
        this.running = 0;
        this.concurrency = concurrency;
        this.maxQueueSize = maxQueueSize;
        this.name = name;
        this.rejectedFull = 0;
    }

    get size() {
        return this.queue.length;
    }

    get pending() {
        return this.queue.length + this.running;
    }

    async add(fn) {
        return new Promise((resolve, reject) => {
            if (this.queue.length >= this.maxQueueSize) {
                this.rejectedFull++;
                const err = new Error("OPERATION_QUEUE_FULL");
                err.code = "OPERATION_QUEUE_FULL";
                err.queueName = this.name;
                reject(err);
                return;
            }
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const { fn, resolve, reject } = this.queue.shift();

        try {
            resolve(await fn());
        } catch (err) {
            reject(err);
        } finally {
            this.running--;
            this.process();
        }
    }
}

const loginQueue = new OperationQueue(2, LOGIN_QUEUE_MAX_SIZE, "login");
const recoveryQueue = new OperationQueue(2, RECOVERY_QUEUE_MAX_SIZE, "recovery");

module.exports = { OperationQueue, loginQueue, recoveryQueue };
