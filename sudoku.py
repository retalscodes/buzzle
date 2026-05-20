import random
import copy


def _ok(board: list, r: int, c: int, n: int) -> bool:
    if n in board[r]:
        return False
    if any(board[i][c] == n for i in range(9)):
        return False
    br, bc = (r // 3) * 3, (c // 3) * 3
    for i in range(br, br + 3):
        for j in range(bc, bc + 3):
            if board[i][j] == n:
                return False
    return True


def _fill(board: list) -> bool:
    for r in range(9):
        for c in range(9):
            if board[r][c] == 0:
                nums = list(range(1, 10))
                random.shuffle(nums)
                for n in nums:
                    if _ok(board, r, c, n):
                        board[r][c] = n
                        if _fill(board):
                            return True
                        board[r][c] = 0
                return False
    return True


def generate_solution() -> list:
    board = [[0] * 9 for _ in range(9)]
    _fill(board)
    return board


def generate_puzzle(difficulty: str = "medium") -> tuple:
    """Return (puzzle, solution). Puzzle has 0s for empty cells."""
    solution = generate_solution()
    puzzle = copy.deepcopy(solution)

    removals = {"easy": 32, "medium": 45, "hard": 52, "expert": 58}.get(difficulty, 45)

    cells = list(range(81))
    random.shuffle(cells)
    for idx in cells[:removals]:
        puzzle[idx // 9][idx % 9] = 0

    return puzzle, solution


def is_correct(solution: list, row: int, col: int, value: int) -> bool:
    return solution[row][col] == value
