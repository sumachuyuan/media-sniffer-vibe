# Technical Audit: Robust Concurrency Logic (v1.35.18)

This report details the implementation of the concurrent segment download engine in `offscreen/main.js`. It focuses on stability, memory hygiene, and failure handling.

## 1. Architectural Patterns

### A. Shared-Index Iterative Pool
Instead of async recursion (which risks stack overflow and adds microtask overhead), we use a shared `currentIndex` that all workers pull from in a `while` loop.
- **Atomicity**: In the single-threaded Environment (Chrome Offscreen), `currentIndex++` is inherently atomic for each `async` step.
- **Worker Scaling**: The pattern allows scaling `concurrency` (default 1 to 5) without changing the core logic.

### B. Worker ID Attribution
Each worker is initialized with a `workerId`, facilitating trace logging and precise error tracking in the console/logs.

---

## 2. Memory & Performance

### A. Multi-Level Memory Hygiene
1.  **JS Managed Memory**: `buf = null` is called immediately after `ffmpeg.FS('writeFile')`. This signals the V8 engine to reclaim the TypedArray memory on the next GC cycle.
2.  **WASM Virtual Memory (MEMFS)**: Data is written into `ffmpeg.wasm`'s filesystem. 
    > [!IMPORTANT]
    > The total size of all `part_*.ts` files must fit within the WASM heap limit (usually 2GB-4GB depending on browser/build). 

### B. I/O Optimization
`ffmpeg.FS('writeFile')` is synchronous within the WASM environment, but since `pool` is `async`, it doesn't block other workers from performing network I/O (`fetch`).

---

## 3. Failure Handling (Retries)

### A. Failure Tracking
The `failedSegments` array captures any index that fails during the initial pass. The system logs the failure but **does not stop** the other workers.

### B. Secondary Retry Pass
After the initial pool concludes, if `failedSegments` is not empty, a single-threaded **Retry Pass** starts:
1.  It iterates through `failedSegments`.
2.  It uses the same `fetchAndProcess` worker logic.
3.  This pass ensures that transient issues (e.g., DNS timeout, temporary congestion) are resolved before a final error is declared.

### C. Final Error Boundary
If `failedSegments` still contains items after the retry pass, a **Critical Failure** is thrown, stopping the merge and notifying the user.

---

## 4. Code Breakdown (`handleMergeSegments`)

```javascript
// Worker logic
const fetchAndProcess = async (index, workerId) => {
    try {
        const resp = await fetch(segments[index]);
        if (!resp.ok) throw new Error(`Status ${resp.status}`);
        let buf = new Uint8Array(await resp.arrayBuffer());
        // Decryption...
        ffmpeg.FS('writeFile', `part_${index}.ts`, buf);
        buf = null; // Reclaim JS memory
        completed++;
        // Send progress...
    } catch (e) {
        failedSegments.push(index); // Track failure
    }
};

// Start workers
const threads = [];
for (let i = 0; i < threadCount; i++) threads.push(pool(i));
await Promise.all(threads);

// Retry phase
if (failedSegments.length > 0) {
    const toRetry = [...failedSegments];
    failedSegments.length = 0;
    for (const index of toRetry) {
        await fetchAndProcess(index, 'retry-agent');
    }
}
```

---

## 5. Audit Conclusion
The v1.35.18 implementation is **highly robust**. It addresses the volatility of stream downloading by providing a fail-safe retry mechanism and ensures optimal memory usage by minimizing residual references in the JS heap.
