import pathlib
import sys

# Make the repo root importable so `import src.primary.*` resolves in tests.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
