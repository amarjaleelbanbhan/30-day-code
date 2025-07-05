#  Simple Calculator (CLI)
print("--------------------------------------------")
print("Welcome to the Simple Calculator!")
print("---------------------------------------------")
def add(x: float, y: float) -> None:
    print(f"{x} + {y} = {x + y}")
def subtract(x: float, y: float) -> None:
    print(f"{x} - {y} = {x - y}")
def multiply(x: float, y: float) -> None:
    print(f"{x} * {y} = {x * y}")
def divide(x: float, y: float) -> None:
    if y != 0:
        print(f"{x} / {y} = {x / y}")
    else:
        print("Error: Division by zero is not allowed.")
def calculator():
    print("Select operation:")
    print("1. Add")
    print("2. Subtract")
    print("3. Multiply")
    print("4. Divide")
    
    while True:
        choice = input("Enter choice (1/2/3/4): ")
        if choice in ('1', '2', '3', '4'):
            try:
                num1 = float(input("Enter first number: "))
                num2 = float(input("Enter second number: "))
            except ValueError:
                print("Invalid input! Please enter numeric values.")
                continue
            
            if choice == '1':
                add(num1, num2)
            elif choice == '2':
                subtract(num1, num2)
            elif choice == '3':
                multiply(num1, num2)
            elif choice == '4':
                divide(num1, num2)
            break
        else:
            print("Invalid choice! Please select a valid operation.")
    print("Thank you for using the Simple Calculator!")
calculator()
