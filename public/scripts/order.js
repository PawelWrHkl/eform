const closeBtn = document.getElementById('cancel-btn');
const confirmBtn = document.getElementById('confirm-btn');
const deletePositionBtns = document.querySelectorAll('.delete-position-btn');
const deleteOrderBtn = document.getElementById('delete-order-btn');
const confirmationDialog = document.getElementById('delete-dialog');
const statusInfo = document.getElementById('status-info');

const commentBtn = document.getElementById('comment-btn');
const editIcon   = document.getElementById('edit-comment-btn');
// const orderId    = commentBtn.dataset.id;

// DELETE dialog
async function deleteItem(path) {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Błąd: ${res.statusText}`);
  const data = await res.json();
  statusInfo.innerHTML = data.message + '. Przenoszenie…';
  statusInfo.classList.add(data.success ? 'alert-success' : 'alert-danger');
  if (data.success) {
    closeBtn.hidden = confirmBtn.hidden = true;
    setTimeout(() => {
      if (path.includes('position')) location.reload();
      else window.location.href = '/orders';
    }, 2500);
  }
}

function deleteDiag(btn) {
  btn.addEventListener('click', () => {
    confirmationDialog.showModal();
    closeBtn.onclick   = () => confirmationDialog.close();
    confirmBtn.onclick = () => deleteItem(btn.dataset.href);
  });
}
deletePositionBtns.forEach(deleteDiag);
if (deleteOrderBtn) deleteDiag(deleteOrderBtn);

// // podpinamy oba “wejścia” do edycji
// commentBtn.addEventListener('click', editComment);
// editIcon.addEventListener('click', editComment);

// function editComment() {
//   const commentInput = document.getElementById('comment-input');
//   const acceptBtn    = document.getElementById('accept-comment-btn');
//   const inputValue = commentInput.dataset.value;
//   commentBtn.classList.add('d-none');
//   editIcon.classList.add('d-none');
//   commentInput.classList.remove('d-none');
//   acceptBtn.classList.remove('d-none');

//     if (inputValue) {
//   commentInput.value = commentInput.dataset.value || commentBtn.textContent.trim();
// }
//   commentInput.focus();


//   const save = async e => {
//     if (e.type === 'keydown' && e.key !== 'Enter') return;

//     const newComment = commentInput.value.trim();

//     if (!newComment) return;

//     try {
//       const res = await fetch(`/orders/${orderId}/comment/update`, {
//         method: 'PATCH',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ comment: newComment })
//       });
//       if (!res.ok) throw new Error(`Status ${res.status}`);
//       commentBtn.textContent = newComment;
//     } catch (err) {
//       console.error('Błąd aktualizacji komentarza:', err);
//     }

//     commentInput.classList.add('d-none');
//     acceptBtn.classList.add('d-none');
//     commentBtn.classList.remove('d-none');
//     editIcon.classList.remove('d-none');

//     commentInput.removeEventListener('keydown', save);
//     acceptBtn.removeEventListener('click', save);
//   };

//   commentInput.addEventListener('keydown', save);
//   acceptBtn.addEventListener('click', save);
// }
