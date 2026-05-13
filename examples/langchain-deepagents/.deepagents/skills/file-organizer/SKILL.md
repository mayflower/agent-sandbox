---
name: file-organizer
description: "Organize files by type, date, or custom criteria. Trigger on phrases like 'organize files', 'sort by type', 'clean up directory'."
version: 1.0.0
tags: [files, organization, cleanup]
---
# File Organizer

## Overview
This skill helps organize files in the sandbox by moving them to appropriate directories based on type, name patterns, or custom criteria.

## Workflow
1. List files in the target directory with `ls_info`
2. Categorize files based on extension or pattern
3. Create destination directories
4. Move files using shell commands

## Organization Strategies

### By Extension
```python
import os
import shutil

extensions = {
    '.py': 'python',
    '.js': 'javascript',
    '.md': 'docs',
    '.json': 'data',
    '.csv': 'data',
}

for filename in os.listdir('/workspace'):
    ext = os.path.splitext(filename)[1]
    if ext in extensions:
        dest = f'/workspace/{extensions[ext]}'
        os.makedirs(dest, exist_ok=True)
        shutil.move(f'/workspace/{filename}', f'{dest}/{filename}')
```

### By Date (modification time)
```python
import os
from datetime import datetime

for filename in os.listdir('/workspace'):
    path = f'/workspace/{filename}'
    mtime = os.path.getmtime(path)
    date_str = datetime.fromtimestamp(mtime).strftime('%Y-%m')
    # organize by year-month
```
