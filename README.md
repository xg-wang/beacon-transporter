# beacon-transporter

[![CI](https://github.com/xg-wang/beacon-transporter/actions/workflows/ci.yml/badge.svg)](https://github.com/xg-wang/beacon-transporter/actions/workflows/ci.yml)

Let you transport data back to server easier.

```javascript
import beacon from 'beacon-transporter';
beacon(`/api`, 'hi', { retryCount: 3 })
```
