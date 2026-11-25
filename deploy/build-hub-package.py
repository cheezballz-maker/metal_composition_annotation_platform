"""Package tracked runtime sources, approved review modules, and built frontend."""
import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import time

root = pathlib.Path(__file__).resolve().parents[1]
assert subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip() == 'build-hub-deploy'
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
paths = [p for p in tracked if p and (
    p in {'backend/requirements.txt', 'README.md', 'COMPOSITION_REVIEW.md'}
    or (pathlib.PurePosixPath(p).parent == pathlib.PurePosixPath('backend')
        and p.endswith('.py') and not pathlib.PurePosixPath(p).name.startswith('test_'))
    or p.startswith('frontend/')
)]
paths += ['deploy/build-hub-backup.sh']
# Explicitly include the approved review implementation before it is committed.
# Never include arbitrary untracked files or the mutable review workspace.
paths += [
    'backend/claim_source.py', 'backend/composition_schema.py', 'backend/description_schema.py',
    'backend/composition_export.py', 'backend/review_store.py',
    'backend/review_workflow.py', 'backend/review_api.py',
    'frontend/src/review/ReviewWorkspace.tsx',
    'frontend/src/review/DescriptionReviewControls.tsx', 'frontend/src/review/descriptionReview.ts',
    'frontend/tests/reviewDescriptionReview.test.ts',
    'frontend/src/review/DescriptionFields.tsx', 'frontend/src/review/descriptionDraft.ts',
    'frontend/src/review/descriptionInheritance.ts', 'frontend/src/review/DescriptionInheritancePanel.tsx',
    'frontend/src/review/DescriptionNavigator.tsx', 'frontend/src/review/descriptionNavigation.ts',
    'frontend/tests/reviewDescriptionNavigation.test.ts', 'frontend/tests/reviewDescriptionEvidence.test.ts',
    'frontend/src/review/descriptionEvidence.ts', 'frontend/src/review/DescriptionEvidencePanel.tsx',
    'frontend/src/review/ReviewContextMenu.tsx',
    'frontend/src/review/locale.tsx',
    'frontend/src/review/RawSourceViewer.tsx',
    'frontend/src/review/rawSource.ts', 'frontend/src/review/numericDraft.ts',
    'frontend/src/review/amountDraft.ts',
    'frontend/src/review/constraintDraft.ts',
    'frontend/src/review/types.ts', 'COMPOSITION_REVIEW.md',
]
paths = [p for p in paths if (root / p).is_file()]
paths += [str(p.relative_to(root)) for p in (root / 'frontend/dist').rglob('*') if p.is_file()]
assert (root / 'frontend/dist/index.html').is_file(), 'Build frontend first'
version = time.strftime('%Y%m%d-%H%M%S', time.gmtime(time.time() + 8 * 3600))
output = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(tempfile.gettempdir()) / f'annotation-platform-{version}.tar.gz'
output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(output, 'w:gz') as archive:
    for name in sorted(set(paths)):
        assert not any(p in {'.git', 'node_modules', '.venv', '__pycache__', '.build-hub', '.planning'} or p.startswith('.env') for p in pathlib.Path(name).parts)
        if pathlib.Path(name).suffix == '.sh':
            content = (root / name).read_bytes().replace(b'\r\n', b'\n')
            info = archive.gettarinfo(str(root / name), arcname=name)
            info.size = len(content)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(content))
        else:
            archive.add(root / name, arcname=name, recursive=False)
assert output.stat().st_size < 50 * 1024 * 1024
print(output)
